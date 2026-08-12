import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { PluginError, wrapError } from './errors.mjs';
import { ensurePrivateDirectory } from './fs.mjs';

/**
 * @param {{ dataRoot: string, workspace: string }} options
 */
export async function resolveWorkspaceStorage({ dataRoot, workspace }) {
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) {
    throw new PluginError('DATA_ROOT_REQUIRED', 'A plugin data root must be provided explicitly.', {
      category: 'configuration',
      remedy: 'Pass the installed plugin data directory as dataRoot.',
    });
  }
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new PluginError('WORKSPACE_REQUIRED', 'A workspace path must be provided.', {
      category: 'configuration',
      remedy: 'Pass the current workspace path.',
    });
  }

  let workspacePath;
  try {
    workspacePath = await realpath(resolve(workspace));
  } catch (error) {
    throw wrapError(error, 'WORKSPACE_RESOLVE_FAILED', `Could not resolve workspace: ${workspace}`, {
      category: 'workspace',
      remedy: 'Pass an existing, accessible workspace directory.',
      details: { workspace },
    });
  }

  const workspaceKey = createHash('sha256').update(workspacePath).digest('hex');
  const resolvedDataRoot = resolve(dataRoot);
  await ensurePrivateDirectory(resolvedDataRoot);
  const dataRootPath = await realpath(resolvedDataRoot);
  const workspacesDirectory = join(dataRootPath, 'workspaces');
  const directory = join(workspacesDirectory, workspaceKey);
  await ensurePrivateDirectory(workspacesDirectory);
  await ensurePrivateDirectory(directory);
  return { dataRootPath, directory, workspaceKey, workspacePath };
}
