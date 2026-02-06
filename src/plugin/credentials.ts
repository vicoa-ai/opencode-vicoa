/**
 * Credentials loader for Vicoa
 *
 * Reads API key from ~/.vicoa/credentials.json (same as Vicoa CLI)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Credentials {
  write_key?: string;
}

/**
 * Get path to Vicoa credentials file
 */
export function getCredentialsPath(): string {
  return path.join(os.homedir(), '.vicoa', 'credentials.json');
}

/**
 * Load Vicoa API key from credentials file
 *
 * Returns the API key from ~/.vicoa/credentials.json if it exists,
 * otherwise returns null.
 */
export function loadApiKey(): string | null {
  const credentialsPath = getCredentialsPath();

  // Check if file exists
  if (!fs.existsSync(credentialsPath)) {
    return null;
  }

  try {
    const data = fs.readFileSync(credentialsPath, 'utf-8');
    const credentials: Credentials = JSON.parse(data);

    const apiKey = credentials.write_key;
    if (apiKey && typeof apiKey === 'string' && apiKey.trim().length > 0) {
      return apiKey.trim();
    }

    return null;
  } catch (error) {
    console.error(`[Vicoa] Error reading credentials file: ${error}`);
    return null;
  }
}

/**
 * Get Vicoa API key from environment or credentials file
 *
 * Priority:
 * 1. VICOA_API_KEY environment variable
 * 2. ~/.vicoa/credentials.json (write_key)
 */
export function getApiKey(): string | null {
  // Check environment variable first
  const envKey = process.env.VICOA_API_KEY;
  if (envKey && envKey.trim().length > 0) {
    return envKey.trim();
  }

  // Fall back to credentials file
  return loadApiKey();
}
