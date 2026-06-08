export {
  IWorkspaceRegistry,
  WorkspaceNotFoundError,
  WorkspaceRootNotFoundError,
  type WorkspacePatch,
} from './workspaceRegistry.js';
export { WorkspaceRegistryService, detectGit } from './workspaceRegistryService.js';
export {
  IWorkspaceFsService,
  WorkspaceFsNotAbsoluteError,
  WorkspaceFsNotFoundError,
  WorkspaceFsPermissionError,
  RECENT_ROOTS_LIMIT,
} from './workspaceFs.js';
export { WorkspaceFsService } from './workspaceFsService.js';
