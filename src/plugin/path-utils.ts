/**
 * Path utilities for normalizing project paths
 *
 * Matches the behavior of Python's vicoa.utils.get_project_path()
 * to ensure consistent path representation across agents.
 */

import * as os from 'os';
import * as path from 'path';

/**
 * Format a project path to use ~ for home directory.
 *
 * This creates a more readable path representation by replacing the home
 * directory prefix with ~, consistent with how paths are displayed across
 * agent instances.
 *
 * @param projectPath - The path to format. Can be absolute or relative.
 * @returns The formatted path with ~ replacing home directory if applicable.
 *
 * @example
 * ```typescript
 * formatProjectPath("/Users/john/projects/myapp")
 * // Returns: "~/projects/myapp"
 *
 * formatProjectPath("/opt/app")
 * // Returns: "/opt/app"
 * ```
 */
export function formatProjectPath(projectPath: string): string {
  // Resolve to absolute path first
  const absolutePath = path.resolve(projectPath);
  const homeDir = os.homedir();

  // Replace home directory with tilde
  if (absolutePath.startsWith(homeDir)) {
    return '~' + absolutePath.slice(homeDir.length);
  }

  return absolutePath;
}

/**
 * Expand ~ in a path to the full home directory path.
 *
 * This is the inverse of formatProjectPath - it converts tilde paths
 * back to absolute paths for use in file operations.
 *
 * @param projectPath - The path to expand (may contain ~)
 * @returns The absolute path with ~ expanded
 *
 * @example
 * ```typescript
 * expandProjectPath("~/projects/myapp")
 * // Returns: "/Users/john/projects/myapp"
 *
 * expandProjectPath("/opt/app")
 * // Returns: "/opt/app"
 * ```
 */
export function expandProjectPath(projectPath: string): string {
  if (projectPath.startsWith('~/') || projectPath === '~') {
    const homeDir = os.homedir();
    return path.join(homeDir, projectPath.slice(2));
  }

  return path.resolve(projectPath);
}
