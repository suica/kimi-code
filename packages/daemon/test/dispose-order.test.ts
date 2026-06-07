/**
 * Dispose-order observability (closes W4 STATUS observability gap).
 *
 * W4 enforced dispose order STRUCTURALLY via `InstantiationService._constructionOrder`
 * (`a.get(X)` records X) but didn't add a SIDE-EFFECT-RECORDING test that
 * actually verifies the array. W5.1 adds it now that we're inserting new
 * services into the dispose chain — a wrong insertion order would silently
 * break broker→logger emit safety.
 *
 * Test strategy: register a stub for every DI decorator the daemon uses,
 * where each stub's `dispose()` pushes its name to a shared `disposeOrder`
 * array. Touch each service in CONSTRUCTION order (matches `start.ts`), then
 * call `ix.dispose()`. Assert the recorded array is REVERSE of construction.
 *
 * Construction order under W12 (Chains 14 + 15 add IFsWatcher + IFileStore):
 *   ILogger → IRestGateway → IConnectionRegistry → ISessionClientsService →
 *   IEventService → IApprovalService → IQuestionService → IWSGateway →
 *   ICoreProcessService → ISessionService → IMessageService → IPromptService →
 *   IToolService → IMcpService → ITaskService → IFsService →
 *   IFsSearchService → IFsGitService → IFsWatcher → IFileStore
 *
 * Expected dispose order (reverse):
 *   IFileStore → IFsWatcher → IFsGitService → IFsSearchService →
 *   IFsService → ITaskService → IMcpService → IToolService →
 *   IPromptService → IMessageService → ISessionService → ICoreProcessService →
 *   IWSGateway → IQuestionService → IApprovalService → IEventService →
 *   ISessionClientsService → IConnectionRegistry → IRestGateway → ILogger
 *
 * Focused invariants:
 *   - WSGateway disposes BEFORE brokers (W5.1)
 *   - SessionClients disposes AFTER EventBus (W5.2)
 *   - ISessionService disposes BEFORE ICoreProcessService (W6.2)
 *   - IMessageService disposes BEFORE ICoreProcessService (W7.1)
 *   - IPromptService disposes BEFORE ICoreProcessService AND BEFORE IEventService
 *     (W7.2 — the service publishes synthetic events; the bus must still be
 *     live during its dispose window if it ever needs to flush)
 *   - IToolService / IMcpService dispose BEFORE ICoreProcessService (W9.1 —
 *     they're thin adapters; bridge teardown after them is safe).
 *   - ITaskService disposes BEFORE ICoreProcessService (W9.2 — same).
 *   - IFsService disposes BEFORE ISessionService (W10 — fs reads
 *     `session.metadata.cwd` during its lifetime; on dispose we just
 *     clear the .gitignore cache, but the construction-after-session
 *     convention places the dispose first regardless).
 *   - IFsSearchService disposes BEFORE ISessionService (W11 / Chain 11).
 *   - IFsGitService disposes BEFORE ISessionService (W11 / Chain 12).
 *   - IFsWatcher disposes BEFORE IFsGitService (W12 / Chain 14 — closes
 *     every chokidar instance before fs-git's session-coupled state
 *     tears down).
 *   - IFileStore disposes BEFORE IFsWatcher (W12 / Chain 15 — store has
 *     no upstream deps; LIFO position).
 */

import { describe, expect, it } from 'vitest';

import {
  InstantiationService,
  ServiceCollection,
  type IDisposable,
} from '@moonshot-ai/agent-core';
import {
  IApprovalService,
  IEventService,
  ICoreProcessService,
  IMcpService,
  IMessageService,
  IPromptService,
  IQuestionService,
  ISessionService,
  ITaskService,
  IToolService,
} from '@moonshot-ai/services';

import { IConnectionRegistry } from '../src/services/connection-registry';
import { IFileStore } from '../src/services/file-store';
import { IFsGitService } from '../src/services/fs-git';
import { IFsSearchService } from '../src/services/fs-search';
import { IFsService } from '../src/services/fs';
import { IFsWatcher } from '../src/services/fs-watcher';
import { ILogger } from '../src/services/logger';
import { IRestGateway } from '../src/services/rest-gateway';
import { ISessionClientsService } from '../src/services/session-clients';
import { IWSGateway } from '../src/services/ws-gateway';

/** Stub implementation whose `dispose()` records ordering. */
function makeRecorder<T>(name: string, sink: string[]): T & IDisposable {
  return {
    dispose(): void {
      sink.push(name);
    },
  } as T & IDisposable;
}

describe('Dispose order is reverse-of-construction (W5.1 closes W4 gap; W6.2 added ISessionService; W7 adds IMessageService + IPromptService; W9.1 adds IToolService + IMcpService; W9.2 adds ITaskService; W10 adds IFsService; W11 Chain 11 adds IFsSearchService; W11 Chain 12 adds IFsGitService; W12 Chain 14 adds IFsWatcher; W12 Chain 15 adds IFileStore)', () => {
  it('records 20 services in exact reverse order', () => {
    const order: string[] = [];

    const services = new ServiceCollection(
      [ILogger, makeRecorder('ILogger', order)],
      [IRestGateway, makeRecorder('IRestGateway', order)],
      [IConnectionRegistry, makeRecorder('IConnectionRegistry', order)],
      [ISessionClientsService, makeRecorder('ISessionClientsService', order)],
      [IEventService, makeRecorder('IEventService', order)],
      [IApprovalService, makeRecorder('IApprovalService', order)],
      [IQuestionService, makeRecorder('IQuestionService', order)],
      [IWSGateway, makeRecorder('IWSGateway', order)],
      [ICoreProcessService, makeRecorder('ICoreProcessService', order)],
      [ISessionService, makeRecorder('ISessionService', order)],
      [IMessageService, makeRecorder('IMessageService', order)],
      [IPromptService, makeRecorder('IPromptService', order)],
      [IToolService, makeRecorder('IToolService', order)],
      [IMcpService, makeRecorder('IMcpService', order)],
      [ITaskService, makeRecorder('ITaskService', order)],
      [IFsService, makeRecorder('IFsService', order)],
      [IFsSearchService, makeRecorder('IFsSearchService', order)],
      [IFsGitService, makeRecorder('IFsGitService', order)],
      [IFsWatcher, makeRecorder('IFsWatcher', order)],
      [IFileStore, makeRecorder('IFileStore', order)],
    );
    const ix = new InstantiationService(services);

    // Touch in CONSTRUCTION order so _constructionOrder reflects start.ts.
    ix.invokeFunction((a) => {
      a.get(ILogger);
      a.get(IRestGateway);
      a.get(IConnectionRegistry);
      a.get(ISessionClientsService);
      a.get(IEventService);
      a.get(IApprovalService);
      a.get(IQuestionService);
      a.get(IWSGateway);
      a.get(ICoreProcessService);
      a.get(ISessionService);
      a.get(IMessageService);
      a.get(IPromptService);
      a.get(IToolService);
      a.get(IMcpService);
      a.get(ITaskService);
      a.get(IFsService);
      a.get(IFsSearchService);
      a.get(IFsGitService);
      a.get(IFsWatcher);
      a.get(IFileStore);
    });

    ix.dispose();

    expect(order).toEqual([
      'IFileStore',
      'IFsWatcher',
      'IFsGitService',
      'IFsSearchService',
      'IFsService',
      'ITaskService',
      'IMcpService',
      'IToolService',
      'IPromptService',
      'IMessageService',
      'ISessionService',
      'ICoreProcessService',
      'IWSGateway',
      'IQuestionService',
      'IApprovalService',
      'IEventService',
      'ISessionClientsService',
      'IConnectionRegistry',
      'IRestGateway',
      'ILogger',
    ]);
  });

  it('logger disposes LAST so broker dispose() can still emit log lines', () => {
    const order: string[] = [];
    const services = new ServiceCollection(
      [ILogger, makeRecorder('ILogger', order)],
      [IEventService, makeRecorder('IEventService', order)],
      [ICoreProcessService, makeRecorder('ICoreProcessService', order)],
    );
    const ix = new InstantiationService(services);
    ix.invokeFunction((a) => {
      a.get(ILogger);
      a.get(IEventService);
      a.get(ICoreProcessService);
    });
    ix.dispose();
    // Verify logger is last regardless of order.
    expect(order[order.length - 1]).toBe('ILogger');
  });

  it('WSGateway disposes before brokers so brokers never emit on a live socket', () => {
    const order: string[] = [];
    const services = new ServiceCollection(
      [IEventService, makeRecorder('IEventService', order)],
      [IApprovalService, makeRecorder('IApprovalService', order)],
      [IQuestionService, makeRecorder('IQuestionService', order)],
      [IWSGateway, makeRecorder('IWSGateway', order)],
    );
    const ix = new InstantiationService(services);
    ix.invokeFunction((a) => {
      a.get(IEventService);
      a.get(IApprovalService);
      a.get(IQuestionService);
      a.get(IWSGateway);
    });
    ix.dispose();
    expect(order.indexOf('IWSGateway')).toBeLessThan(order.indexOf('IEventService'));
    expect(order.indexOf('IWSGateway')).toBeLessThan(order.indexOf('IApprovalService'));
    expect(order.indexOf('IWSGateway')).toBeLessThan(order.indexOf('IQuestionService'));
  });

  it('SessionClients disposes AFTER EventBus so the bus stops publishing before subscriber index drops', () => {
    const order: string[] = [];
    const services = new ServiceCollection(
      [ISessionClientsService, makeRecorder('ISessionClientsService', order)],
      [IEventService, makeRecorder('IEventService', order)],
    );
    const ix = new InstantiationService(services);
    ix.invokeFunction((a) => {
      a.get(ISessionClientsService);
      a.get(IEventService);
    });
    ix.dispose();
    // EventBus disposes BEFORE SessionClients (reverse-of-construction):
    expect(order.indexOf('IEventService')).toBeLessThan(order.indexOf('ISessionClientsService'));
  });

  it('ISessionService disposes BEFORE ICoreProcessService so the service can rely on a live bridge during its own teardown (W6.2)', () => {
    const order: string[] = [];
    const services = new ServiceCollection(
      [ICoreProcessService, makeRecorder('ICoreProcessService', order)],
      [ISessionService, makeRecorder('ISessionService', order)],
    );
    const ix = new InstantiationService(services);
    ix.invokeFunction((a) => {
      a.get(ICoreProcessService);
      a.get(ISessionService);
    });
    ix.dispose();
    // ISessionService disposes BEFORE ICoreProcessService — reverse of construction.
    expect(order.indexOf('ISessionService')).toBeLessThan(order.indexOf('ICoreProcessService'));
  });

  it('IMessageService disposes BEFORE ICoreProcessService so the service can rely on a live bridge during its own teardown (W7.1)', () => {
    const order: string[] = [];
    const services = new ServiceCollection(
      [ICoreProcessService, makeRecorder('ICoreProcessService', order)],
      [IMessageService, makeRecorder('IMessageService', order)],
    );
    const ix = new InstantiationService(services);
    ix.invokeFunction((a) => {
      a.get(ICoreProcessService);
      a.get(IMessageService);
    });
    ix.dispose();
    expect(order.indexOf('IMessageService')).toBeLessThan(order.indexOf('ICoreProcessService'));
  });

  it('IPromptService disposes BEFORE IEventService AND ICoreProcessService (W7.2)', () => {
    const order: string[] = [];
    const services = new ServiceCollection(
      [IEventService, makeRecorder('IEventService', order)],
      [ICoreProcessService, makeRecorder('ICoreProcessService', order)],
      [IPromptService, makeRecorder('IPromptService', order)],
    );
    const ix = new InstantiationService(services);
    ix.invokeFunction((a) => {
      a.get(IEventService);
      a.get(ICoreProcessService);
      a.get(IPromptService);
    });
    ix.dispose();
    expect(order.indexOf('IPromptService')).toBeLessThan(order.indexOf('IEventService'));
    expect(order.indexOf('IPromptService')).toBeLessThan(order.indexOf('ICoreProcessService'));
  });

  it('IToolService + IMcpService dispose BEFORE ICoreProcessService so the bridge stays live during their dispose (W9.1)', () => {
    const order: string[] = [];
    const services = new ServiceCollection(
      [ICoreProcessService, makeRecorder('ICoreProcessService', order)],
      [IToolService, makeRecorder('IToolService', order)],
      [IMcpService, makeRecorder('IMcpService', order)],
    );
    const ix = new InstantiationService(services);
    ix.invokeFunction((a) => {
      a.get(ICoreProcessService);
      a.get(IToolService);
      a.get(IMcpService);
    });
    ix.dispose();
    expect(order.indexOf('IMcpService')).toBeLessThan(order.indexOf('ICoreProcessService'));
    expect(order.indexOf('IToolService')).toBeLessThan(order.indexOf('ICoreProcessService'));
    // IMcpService was constructed AFTER IToolService → disposes FIRST.
    expect(order.indexOf('IMcpService')).toBeLessThan(order.indexOf('IToolService'));
  });

  it('ITaskService disposes BEFORE ICoreProcessService so the bridge stays live during its dispose (W9.2)', () => {
    const order: string[] = [];
    const services = new ServiceCollection(
      [ICoreProcessService, makeRecorder('ICoreProcessService', order)],
      [ITaskService, makeRecorder('ITaskService', order)],
    );
    const ix = new InstantiationService(services);
    ix.invokeFunction((a) => {
      a.get(ICoreProcessService);
      a.get(ITaskService);
    });
    ix.dispose();
    expect(order.indexOf('ITaskService')).toBeLessThan(order.indexOf('ICoreProcessService'));
  });

  it('IFsService disposes BEFORE ISessionService so the cwd lookup stays live during its dispose (W10)', () => {
    const order: string[] = [];
    const services = new ServiceCollection(
      [ISessionService, makeRecorder('ISessionService', order)],
      [IFsService, makeRecorder('IFsService', order)],
    );
    const ix = new InstantiationService(services);
    ix.invokeFunction((a) => {
      a.get(ISessionService);
      a.get(IFsService);
    });
    ix.dispose();
    expect(order.indexOf('IFsService')).toBeLessThan(
      order.indexOf('ISessionService'),
    );
  });

  it('IFsSearchService disposes BEFORE ISessionService AND BEFORE IFsService (W11 / Chain 11)', () => {
    const order: string[] = [];
    const services = new ServiceCollection(
      [ISessionService, makeRecorder('ISessionService', order)],
      [IFsService, makeRecorder('IFsService', order)],
      [IFsSearchService, makeRecorder('IFsSearchService', order)],
    );
    const ix = new InstantiationService(services);
    ix.invokeFunction((a) => {
      a.get(ISessionService);
      a.get(IFsService);
      a.get(IFsSearchService);
    });
    ix.dispose();
    expect(order.indexOf('IFsSearchService')).toBeLessThan(
      order.indexOf('ISessionService'),
    );
    expect(order.indexOf('IFsSearchService')).toBeLessThan(
      order.indexOf('IFsService'),
    );
  });

  it('IFsGitService disposes BEFORE ISessionService AND BEFORE IFsSearchService (W11 / Chain 12)', () => {
    const order: string[] = [];
    const services = new ServiceCollection(
      [ISessionService, makeRecorder('ISessionService', order)],
      [IFsService, makeRecorder('IFsService', order)],
      [IFsSearchService, makeRecorder('IFsSearchService', order)],
      [IFsGitService, makeRecorder('IFsGitService', order)],
    );
    const ix = new InstantiationService(services);
    ix.invokeFunction((a) => {
      a.get(ISessionService);
      a.get(IFsService);
      a.get(IFsSearchService);
      a.get(IFsGitService);
    });
    ix.dispose();
    expect(order.indexOf('IFsGitService')).toBeLessThan(
      order.indexOf('ISessionService'),
    );
    expect(order.indexOf('IFsGitService')).toBeLessThan(
      order.indexOf('IFsSearchService'),
    );
  });

  it('IFsWatcher disposes BEFORE IFsGitService AND BEFORE ISessionService (W12 / Chain 14)', () => {
    const order: string[] = [];
    const services = new ServiceCollection(
      [ISessionService, makeRecorder('ISessionService', order)],
      [IFsService, makeRecorder('IFsService', order)],
      [IFsSearchService, makeRecorder('IFsSearchService', order)],
      [IFsGitService, makeRecorder('IFsGitService', order)],
      [IFsWatcher, makeRecorder('IFsWatcher', order)],
    );
    const ix = new InstantiationService(services);
    ix.invokeFunction((a) => {
      a.get(ISessionService);
      a.get(IFsService);
      a.get(IFsSearchService);
      a.get(IFsGitService);
      a.get(IFsWatcher);
    });
    ix.dispose();
    // IFsWatcher constructed LAST → disposes FIRST.
    expect(order.indexOf('IFsWatcher')).toBeLessThan(
      order.indexOf('IFsGitService'),
    );
    expect(order.indexOf('IFsWatcher')).toBeLessThan(
      order.indexOf('ISessionService'),
    );
    // And first in the array overall (LIFO).
    expect(order[0]).toBe('IFsWatcher');
  });

  it('IFileStore disposes BEFORE IFsWatcher (W12 / Chain 15)', () => {
    const order: string[] = [];
    const services = new ServiceCollection(
      [IFsWatcher, makeRecorder('IFsWatcher', order)],
      [IFileStore, makeRecorder('IFileStore', order)],
    );
    const ix = new InstantiationService(services);
    ix.invokeFunction((a) => {
      a.get(IFsWatcher);
      a.get(IFileStore);
    });
    ix.dispose();
    // IFileStore constructed LAST → disposes FIRST.
    expect(order.indexOf('IFileStore')).toBeLessThan(
      order.indexOf('IFsWatcher'),
    );
    expect(order[0]).toBe('IFileStore');
  });
});
