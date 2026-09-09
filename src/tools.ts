import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PlanInfo, PlanTier, ToolResult, TIER_RANK, normalizeTier } from './types';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
  /**
   * Minimum plan tier required to use this tool.
   * Uses the real 4-tier system from lib/constants.ts:
   *   free | starter | pro | ultimate
   */
  minTier: PlanTier;
}

/**
 * ToolRegistry defines the "agentic" tools the AI can use and executes them
 * against the local VS Code workspace — same idea as Cline's tools.
 *
 * Tool availability is gated by the user's subscription tier, mirroring the
 * backend's `isModelAllowedForTier()` / `getUserPlanTier()` logic.
 */
export class ToolRegistry {
  private definitions: ToolDefinition[] = [
    {
      name: 'read_file',
      description: 'Read the content of a file in the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute or workspace-relative path' } },
        required: ['path'],
      },
      minTier: 'free',
    },
    {
      name: 'list_files',
      description: 'List files and folders in a directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory to list (defaults to workspace root)' } },
        required: [],
      },
      minTier: 'free',
    },
    {
      name: 'search',
      description: 'Search the workspace for a text pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          fileTypes: { type: 'string', description: 'Comma-separated globs, e.g. "ts,js"' },
        },
        required: ['pattern'],
      },
      minTier: 'free',
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      minTier: 'starter',
    },
    {
      name: 'edit_file',
      description: 'Replace the first occurrence of `search` with `replace` in a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          search: { type: 'string' },
          replace: { type: 'string' },
        },
        required: ['path', 'search', 'replace'],
      },
      minTier: 'starter',
    },
    {
      name: 'run_command',
      description: 'Run a shell/terminal command in the integrated terminal.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      minTier: 'pro',
    },
  ];

  constructor(private readonly getPlan: () => PlanInfo | undefined) {}

  /** Returns only the tools unlocked for the user's current tier. */
  getDefinitions(): ToolDefinition[] {
    const plan = this.getPlan();
    const tier: PlanTier = normalizeTier(plan?.plan);
    return this.definitions.filter((d) => TIER_RANK[d.minTier] <= TIER_RANK[tier]);
  }

  publicDefinitions(): { name: string; description: string; parameters: Record<string, any> }[] {
    return this.getDefinitions().map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    }));
  }

  /** True when the given tool is allowed on the user's current tier. */
  isAllowed(name: string): boolean {
    const def = this.definitions.find((d) => d.name === name);
    if (!def) return false;
    const tier: PlanTier = normalizeTier(this.getPlan()?.plan);
    return TIER_RANK[def.minTier] <= TIER_RANK[tier];
  }

  async execute(name: string, args: Record<string, any>): Promise<ToolResult> {
    // Enforce the tier gate at execution time too (defence in depth).
    if (!this.isAllowed(name)) {
      const tier = normalizeTier(this.getPlan()?.plan);
      return {
        success: false,
        output: `Tool "${name}" is not available on your ${tier} plan. Upgrade to unlock it.`,
      };
    }

    try {
      switch (name) {
        case 'read_file':
          return { success: true, output: await this.readFile(args.path) };
        case 'write_file':
          return { success: true, output: await this.writeFile(args.path, args.content) };
        case 'edit_file':
          return { success: true, output: await this.editFile(args.path, args.search, args.replace) };
        case 'list_files':
          return { success: true, output: await this.listFiles(args.path) };
        case 'run_command':
          return { success: true, output: await this.runCommand(args.command) };
        case 'search':
          return { success: true, output: await this.search(args.pattern, args.fileTypes) };
        default:
          return { success: false, output: `Unknown tool: ${name}` };
      }
    } catch (e: any) {
      return { success: false, output: `Tool error (${name}): ${e?.message || e}` };
    }
  }

  private resolve(p: string): string {
    if (!p) {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      return ws || process.cwd();
    }
    if (path.isAbsolute(p)) {
      return p;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.join(root, p) : path.resolve(p);
  }

  private async readFile(p: string): Promise<string> {
    const full = this.resolve(p);
    return fs.promises.readFile(full, 'utf8');
  }

  private async writeFile(p: string, content: string): Promise<string> {
    const full = this.resolve(p);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, content, 'utf8');
    return `Wrote ${full} (${content.length} chars)`;
  }

  private async editFile(p: string, search: string, replace: string): Promise<string> {
    const full = this.resolve(p);
    const original = await fs.promises.readFile(full, 'utf8');
    if (!original.includes(search)) {
      return `No match found for the search string in ${full}`;
    }
    const updated = original.replace(search, replace);
    await fs.promises.writeFile(full, updated, 'utf8');
    return `Edited ${full}: replaced 1 occurrence`;
  }

  private async listFiles(p?: string): Promise<string> {
    const full = this.resolve(p || '');
    const entries = await fs.promises.readdir(full, { withFileTypes: true });
    const lines = entries
      .map((e) => (e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`))
      .join('\n');
    return (lines || '(empty directory)') + `\n\n(${full})`;
  }

  private async search(pattern: string, fileTypes?: string): Promise<string> {
    const include = fileTypes
      ? fileTypes.split(',').map((f) => `**/*.${f.trim()}`)
      : '**/*';
    const files = await vscode.workspace.findFiles(include, '**/node_modules/**', 200);
    const results: string[] = [];
    const re = new RegExp(pattern, 'i');
    for (const file of files) {
      const text = await fs.promises.readFile(file.fsPath, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (re.test(line)) {
          results.push(`${file.fsPath}:${i + 1}: ${line.trim().slice(0, 200)}`);
        }
      });
      if (results.length > 50) {
        break;
      }
    }
    return results.length ? results.slice(0, 50).join('\n') : `No matches for "${pattern}"`;
  }

  private async runCommand(command: string): Promise<string> {
    const terminal = vscode.window.createTerminal('Meldrix');
    terminal.show();
    terminal.sendText(command);
    return `Running in terminal: ${command}`;
  }
}
