# `@moonshot-ai/services`

In-process service container for the kimi-code daemon. Every public
member follows the VSCode platform-service convention so DI wiring,
docstrings, and call-site ergonomics stay uniform.

## Naming convention (normative)

Every injectable thing in this package uses the **`Service`** suffix.
No `Bus`, no `Broker`, no `Bridge`, no `Registry`, no `Manager`.

- **Decorator**: `export const IXxxService = createDecorator<IXxxService>('xxxService')`
- **Interface**: `export interface IXxxService { readonly _serviceBrand: undefined; ... }`
- **Class**: `export class XxxService implements IXxxService { ... }`
- **Decorator string** (3rd arg of `createDecorator`): lowerCamelCase
  of the interface name minus the leading `I` — `xxxService`. This
  string surfaces in `CyclicDependencyError.path` and `No service
  registered for identifier ...` messages, so it must be unique and
  stable.

The role (business facade / one-shot reverse-RPC broker / pub-sub bus /
cross-process RPC adapter) is communicated through the **docstring**
and the **interface shape**, not the suffix. Patterns:

| Role | Interface signature | Example |
|---|---|---|
| Business facade | mostly `Promise<T>` returns | `IPromptService.submit(...)` |
| One-shot broker | `request(req): Promise<resp>` + `resolve(id, resp)` | `IApprovalService` |
| Pub-sub bus | `publish(e)` + `subscribe(h): () => void` OR `readonly onXxx: Event<T>` | `IEventService` |
| Cross-process adapter | `readonly rpc: ...` + `ready(): Promise<void>` | `ICoreProcessService` |

## File / folder convention (normative)

- One folder per domain, **camelCase**, no kebab: `coreProcess/`,
  `authSummary/`, NOT `core-process/`, NOT `auth-summary/`.
- **Contracts** file = `<domain>.ts` (camelCase, no `Service` suffix).
  Holds the interface, decorator, sentinel errors, adapter helpers,
  and protocol↔in-process shape translations.
- **Impl** file = `<domain>Service.ts` (camelCase, with `Service`
  suffix). Holds the concrete class. Imports the decorator + interface
  from the sibling contracts file.

Example domain layout:

    coreProcess/
      coreProcess.ts          ← ICoreProcessService, CoreProcessServiceOptions
      coreProcessService.ts   ← CoreProcessService implements ICoreProcessService

This mirrors `vscode/src/vs/platform/<domain>/common/<domain>.ts` +
`<domain>Service.ts`.

## Out of scope (intentionally deferred)

The following are recognised as VSCode-aligned improvements but **NOT**
covered by this convention today; they would be follow-up refactors:

1. **Split `ICoreProcessService.rpc` (current `CoreRPC` mega-proxy)
   into per-domain typed slices**, so a `SessionService` only sees
   `Pick<CoreRPC, 'createSession' | 'listSessions' | ...>` and not the
   entire `CoreAPI`. Pure soft slicing (no `agent-core` changes) gives
   us boundary discipline + test ergonomics without the IPC-channel
   cost.
2. **Dissolve `IEventService`** into per-service typed `Event<T>`
   properties wired off a single core stream. Today `IEventService`
   stays as the central pub-sub; per-service `onDidXxx: Event<T>`
   accessors layer **on top** of it.
3. **Real channel registry** (`getChannel(name) / registerChannel(...)`
   on `ICoreProcessService`) mirroring VSCode's `IMainProcessService`.
   Requires `agent-core` RPC layer changes.

When taking on (1) or (2), the new types still follow the rules above —
no new suffixes get reintroduced.

## Per-domain layout (current)

| Folder | Contracts | Impl | Decorator |
|---|---|---|---|
| `coreProcess/` | `coreProcess.ts` | `coreProcessService.ts` | `ICoreProcessService` |
| `event/` | `event.ts` | (impl lives in daemon) | `IEventService` |
| `approval/` | `approval.ts` | (impl lives in daemon) | `IApprovalService` |
| `question/` | `question.ts` | (impl lives in daemon) | `IQuestionService` |
| `environment/` | `environment.ts` | (impl lives in daemon) | `IEnvironmentService` |
| `session/` | `session.ts` | `sessionService.ts` | `ISessionService` |
| `message/` | `message.ts` | `messageService.ts` | `IMessageService` |
| `prompt/` | `prompt.ts` | `promptService.ts` | `IPromptService` |
| `tool/` | `tool.ts` | `toolService.ts` | `IToolService` |
| `mcp/` | `mcp.ts` | `mcpService.ts` | `IMcpService` |
| `task/` | `task.ts` | `taskService.ts` | `ITaskService` |
| `oauth/` | `oauth.ts` | `oauthService.ts` | `IOAuthService` |
| `authSummary/` | `authSummary.ts` | `authSummaryService.ts` | `IAuthSummaryService` |

Adding a new service: create the folder + contracts + impl pair, add the
entry to `defaultServicesModule()` in `module.ts`, add a `services.set(...)`
in daemon's `start.ts`, re-export from `index.ts`.
