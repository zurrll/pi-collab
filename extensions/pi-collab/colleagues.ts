/**
 * Colleague template discovery and configuration.
 *
 * Colleague templates are .md files with frontmatter, similar to subagent's
 * agent definitions. They live in:
 *
 *   ~/.pi/agent/colleagues/*.md   (global — available in all projects)
 *   .pi/colleagues/*.md            (project-local — shared with your team)
 *
 * Format:
 * ```markdown
 * ---
 * name: reviewer
 * description: Code reviewer focused on correctness and security
 * model: anthropic/claude-sonnet-4-20250514
 * tools: read, bash, edit, write, grep, find, ls
 * ---
 *
 * You are a code reviewer. Focus on:
 * - Correctness and edge cases
 * - Security vulnerabilities
 * - Performance implications
 * - Code clarity and maintainability
 *
 * Provide structured feedback with severity ratings.
 * ```
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, CONFIG_DIR_NAME, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface ColleagueTemplate {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface ColleagueDiscoveryResult {
  templates: ColleagueTemplate[];
  projectColleaguesDir: string | null;
}

function loadColleaguesFromDir(dir: string, source: "user" | "project"): ColleagueTemplate[] {
  const templates: ColleagueTemplate[] = [];

  if (!existsSync(dir)) return templates;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return templates;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;

    const filePath = join(dir, entry);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    templates.push({
      name: frontmatter.name,
      description: frontmatter.description,
      model: frontmatter.model,
      tools: tools && tools.length > 0 ? tools : undefined,
      systemPrompt: body.trim(),
      source,
      filePath,
    });
  }

  return templates;
}

function findNearestProjectColleaguesDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = join(currentDir, CONFIG_DIR_NAME, "colleagues");
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* skip */ }

    const parentDir = join(currentDir, "..");
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/**
 * Discover all available colleague templates.
 * Project templates override global templates with the same name.
 */
export function discoverColleagues(cwd: string): ColleagueDiscoveryResult {
  const userDir = join(getAgentDir(), "colleagues");
  const projectDir = findNearestProjectColleaguesDir(cwd);

  const userTemplates = loadColleaguesFromDir(userDir, "user");
  const projectTemplates = projectDir ? loadColleaguesFromDir(projectDir, "project") : [];

  // Project templates override global templates with the same name
  const map = new Map<string, ColleagueTemplate>();
  for (const t of userTemplates) map.set(t.name, t);
  for (const t of projectTemplates) map.set(t.name, t);

  return {
    templates: Array.from(map.values()),
    projectColleaguesDir: projectDir,
  };
}

/**
 * Resolve a colleague template by name. Returns undefined if not found.
 */
export function resolveColleague(
  name: string,
  cwd: string,
): ColleagueTemplate | undefined {
  const { templates } = discoverColleagues(cwd);
  return templates.find((t) => t.name === name);
}

/**
 * Format a colleague template list for display.
 */
export function formatColleagueList(templates: ColleagueTemplate[]): string {
  if (templates.length === 0) return "none";
  return templates
    .map((t) => `  ${t.name} (${t.source}) — ${t.description}`)
    .join("\n");
}
