import { useAuth } from '@/contexts/AuthContext';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { apiDelete, apiGet } from '@/utils/fetchInterceptor';
import { splitServerKey } from '../../../src/utils/catalog';
import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  RefreshCw,
  Search,
  Upload,
  FileCode,
  AlertCircle,
  X,
  ArrowDownAZ,
} from 'lucide-react';
import { Server } from '@/types';
import ServerCard from '@/components/ServerCard';
import AddServerForm from '@/components/AddServerForm';
import EditServerForm from '@/components/EditServerForm';
import McpbUploadForm from '@/components/McpbUploadForm';
import JSONImportForm from '@/components/JSONImportForm';
import Pagination from '@/components/ui/Pagination';
import { useServerData } from '@/hooks/useServerData';
import { useCostData } from '@/hooks/useCostData';
import { selectServerPage, getServerFilterCounts, type ServerFilter } from '@/utils/serverFilters';
import { resolveDuplicateResponse } from '@/utils/serverDuplicate';

const ServersPage: React.FC = () => {
  const { t } = useTranslation();
  const { auth } = useAuth();
  const [relayReady, setRelayReady] = useState<boolean>();
  const [relayModes, setRelayModes] = useState<Record<string, 'enabled' | 'task'>>({});
  useEffect(() => {
    if (!auth.user?.isAdmin) return;
    let active = true;
    const load = async () => {
      const [settings, runtime] = await Promise.all([
        apiGet('/relay/config'),
        apiGet('/relay/runtime'),
      ]);
      if (active && settings.success) setRelayModes(settings.data.serverRelay ?? {});
      if (active)
        setRelayReady(
          !!(
            settings.success &&
            settings.data.relay.enabled &&
            settings.data.hasRelayToken &&
            runtime.success &&
            runtime.data.healthy
          ),
        );
    };
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [auth.user?.isAdmin]);
  const navigate = useNavigate();
  const {
    servers,
    allServers,
    error,
    setError,
    isLoading,
    currentPage,
    serversPerPage,
    setCurrentPage,
    setServersPerPage,
    handleServerAdd,
    handleServerEdit,
    handleServerRemove,
    handleServerToggle,
    handleServerVisibilityChange,
    handleServerReload,
    handleServerReinstall,
    handleServerOAuthDisconnect,
    triggerRefresh,
  } = useServerData({ refreshOnMount: true });

  const { serverCosts, refetch: refetchCost } = useCostData();

  // Re-fetch context footprint whenever server data changes (toggle, reload, edit).
  useEffect(() => {
    refetchCost();
  }, [servers, refetchCost]);

  const [editingServer, setEditingServer] = useState<Server | null>(null);
  const [duplicateServer, setDuplicateServer] = useState<Server | null>(null);
  const [duplicatingServer, setDuplicatingServer] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showMcpbUpload, setShowMcpbUpload] = useState(false);
  const [showJsonImport, setShowJsonImport] = useState(false);
  const [filter, setFilter] = useState<ServerFilter>('all');
  const [search, setSearch] = useState('');
  const [catalog, setCatalog] = useState('*');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [batchResult, setBatchResult] = useState('');
  useEffect(() => {
    setSelected(new Set());
  }, [catalog, filter, search]);
  const deleteSelected = async () => {
    if (deleting) return;
    setDeleting(true);
    const failed: string[] = [];
    let removed = 0;
    for (const name of selected) {
      try {
        const result = await apiDelete(`/servers/${encodeURIComponent(name)}`);
        if (!result.success) throw new Error(result.message || t('serverBatch.failed'));
        removed++;
      } catch (cause) {
        failed.push(name);
        setError(`${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    setSelected(new Set(failed));
    setBatchResult(t('serverBatch.result', { removed, failed: failed.length }));
    setDeleting(false);
    setConfirmBatchDelete(false);
    triggerRefresh();
  };
  const catalogNames = useMemo(
    () =>
      [
        ...new Set(allServers.map((server) => splitServerKey(server.name).catalog).filter(Boolean)),
      ].sort(),
    [allServers],
  );
  const catalogServers = useMemo(
    () =>
      allServers.filter(
        (server) => catalog === '*' || splitServerKey(server.name).catalog === catalog,
      ),
    [allServers, catalog],
  );
  const [sortByName, setSortByName] = useState(
    () => localStorage.getItem('mcphub_server_sort') === 'name',
  );
  useEffect(() => {
    localStorage.setItem('mcphub_server_sort', sortByName ? 'name' : 'default');
  }, [sortByName]);
  const orderedServers = useMemo(
    () =>
      sortByName
        ? [...catalogServers].sort((a, b) =>
            a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }),
          )
        : catalogServers,
    [catalogServers, sortByName],
  );

  const counts = useMemo(() => getServerFilterCounts(catalogServers), [catalogServers]);

  // Filter against the full list and paginate the filtered result client-side,
  // so status filters reach servers that live on other pagination pages.
  const { servers: visibleServers, pagination: clientPagination } = useMemo(
    () => selectServerPage(orderedServers, filter, search, currentPage, serversPerPage),
    [orderedServers, filter, search, currentPage, serversPerPage],
  );

  // Sync currentPage when client-side pagination clamps it (filter/search narrows results).
  useEffect(() => {
    if (clientPagination.page !== currentPage) {
      setCurrentPage(clientPagination.page);
    }
  }, [clientPagination.page, currentPage, setCurrentPage]);

  // Edit opens the modal from a `GET /servers/<name>` response, so it has the
  // same interleave race the Duplicate B1 guard fixes: click Edit on A, then
  // click Edit on B while A's request is still in flight - A's late response
  // would otherwise overwrite `editingServer` after B's already opened, and
  // `EditServerForm.handleSubmit` would `PUT` B's form values onto A (silent
  // cross-server write, same causal mechanism as the Duplicate race).
  //
  // Fix: same B1 pattern - a monotonically increasing request id that is never
  // reset. Each accepted click bumps it; the response is only committed if its
  // id is still the latest, so a superseded/stale response is dropped. The
  // commit check is a plain equality comparison (the `resolveDuplicateResponse`
  // helper is left to the Duplicate flow, whose busy-clear `finally` is the
  // only consumer of the 'commit' | 'stale' wording). Edit has no busy
  // indicator, so there is no spinner state to guard here. The ref is separate
  // from `duplicateRequestId` on purpose: the two flows are unrelated, and
  // sharing one counter would let a click in one flow discard the other's
  // in-flight response.
  const editRequestId = useRef(0); // bumped on every accepted click
  const handleEditClick = async (server: Server) => {
    const requestId = ++editRequestId.current;
    const fullServerData = await handleServerEdit(server);
    // Drop a stale response: a newer click superseded this request, so
    // committing it would open the modal for the wrong server.
    if (requestId !== editRequestId.current) return;
    if (fullServerData) setEditingServer(fullServerData);
  };

  // Duplicate pre-fills the add form, so it needs the same full stored
  // configuration the edit flow loads - the card only carries the list
  // projection, which has no env/headers/credential template (#1187).
  //
  // B1: guard against interleaved clicks. A slow `GET /servers/A` can still be
  // in flight when the user clicks Duplicate on B (the `duplicatingServer`
  // guard only blocks re-clicking the *same* name). Without a guard the two
  // responses would race and the stale one could overwrite the prefill after
  // the modal already opened, so the form would show one server while
  // `handleSubmit` re-attaches another server's capability overrides to the
  // payload (silent cross-server data corruption).
  //
  // Fix: a monotonically increasing request id (never reset). Each accepted
  // click bumps it; the response is only committed if its request id is still
  // the latest (any superseded/stale response is dropped). The `finally` also
  // only clears the busy indicator when this request is still the latest, so a
  // superseded request's late return can no longer clear the newer request's
  // spinner early. Because the id is monotonic and never reset, the winning
  // request always satisfies `requestId === duplicateRequestId.current` in both
  // the commit check and the `finally`, so the busy indicator is always cleared.
  const duplicateRequestId = useRef(0); // bumped on every accepted click
  const handleDuplicateClick = async (server: Server) => {
    // Ignore repeat clicks while this server's stored config is still loading,
    // so a slow request cannot fire twice.
    if (duplicatingServer === server.name) return;
    const requestId = ++duplicateRequestId.current;
    setDuplicatingServer(server.name);
    try {
      const fullServerData = await handleServerEdit(server);
      // Drop a stale response: a newer click superseded this request, so
      // committing it would overwrite the prefill with the wrong server.
      if (resolveDuplicateResponse(requestId, duplicateRequestId.current) === 'stale') return;
      if (fullServerData) setDuplicateServer(fullServerData);
    } finally {
      // Only clear the busy indicator when this request is still the latest;
      // a superseded request must not erase the newer request's spinner. On the
      // winning path `resolveDuplicateResponse` returns 'commit'
      // (`requestId === duplicateRequestId.current` holds), so the busy
      // indicator is always cleared here.
      if (resolveDuplicateResponse(requestId, duplicateRequestId.current) === 'commit') {
        setDuplicatingServer(null);
      }
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      triggerRefresh();
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="hub-h1">{t('pages.servers.title')}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="hub-btn" onClick={() => navigate('/market')}>
            <Plus size={13} /> {t('nav.market')}
          </button>
          <button className="hub-btn" onClick={() => setShowJsonImport(true)}>
            <FileCode size={13} /> {t('jsonImport.button')}
          </button>
          <button className="hub-btn" onClick={() => setShowMcpbUpload(true)}>
            <Upload size={13} /> {t('mcpb.upload')}
          </button>
          <button
            className="hub-btn"
            onClick={handleRefresh}
            disabled={isRefreshing}
            aria-label={t('common.refresh')}
          >
            <RefreshCw size={13} className={isRefreshing ? 'animate-spin' : ''} />
            {t('common.refresh')}
          </button>
          <AddServerForm
            defaultCatalog={catalog === '*' ? '' : catalog}
            onAdd={handleServerAdd}
            duplicateSource={duplicateServer}
            onDuplicateCancel={() => setDuplicateServer(null)}
          />
        </div>
      </div>

      {error && (
        <div
          className="hub-card flex items-center justify-between gap-3 mb-4"
          style={{
            padding: '10px 14px',
            borderColor: 'oklch(0.85 0.1 25)',
            background: 'oklch(0.97 0.03 25)',
            color: 'oklch(0.4 0.18 25)',
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle size={14} className="flex-shrink-0" />
            <span className="truncate text-[13px]">{error}</span>
          </div>
          <button
            className="hub-icon-btn sm"
            onClick={() => setError(null)}
            aria-label={t('app.closeButton')}
          >
            <X size={13} />
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <label htmlFor="catalog-filter" className="text-sm whitespace-nowrap">
          {t('catalog.label')}
        </label>
        <select
          id="catalog-filter"
          className="hub-input"
          style={{ width: 220, maxWidth: '40vw' }}
          value={catalog}
          onChange={(event) => {
            setCatalog(event.target.value);
            setCurrentPage(1);
          }}
        >
          <option value="*">{t('catalog.all')}</option>
          <option value="">{t('catalog.public')}</option>
          {catalogNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="hub-filter-tabs" role="group" aria-label={t('uiLayout.statusFilter')}>
          {(
            [
              ['all', t('common.all') || 'All', counts.all],
              ['online', t('status.online'), counts.online],
              ['tasks', t('uiLayout.mode_task'), counts.tasks],
              ['issues', t('common.inactive') || 'Issues', counts.issues],
              ['disabled', t('pages.dashboard.disabledServers') || 'Disabled', counts.disabled],
            ] as [ServerFilter, string, number][]
          ).map(([k, l, n]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`hub-filter-tab ${filter === k ? 'is-active' : ''}`}
              aria-pressed={filter === k}
            >
              {l}
              <span className="hub-filter-count">{n}</span>
            </button>
          ))}
        </div>

        <div
          className="hub-search-field flex items-center gap-2 px-2.5 flex-1"
          style={{ height: 30, background: 'var(--hub-surface)', maxWidth: 360 }}
        >
          <Search size={13} style={{ color: 'var(--hub-ink-3)' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent outline-none text-[13px]"
            style={{ color: 'var(--hub-ink)' }}
            placeholder={t('market.searchPlaceholder') || 'Search…'}
          />
          {search && (
            <button onClick={() => setSearch('')} className="hub-icon-btn sm">
              <X size={11} />
            </button>
          )}
        </div>

        <button
          type="button"
          className="hub-icon-btn"
          title={t(sortByName ? 'server.restoreDefaultOrder' : 'server.sortByName')}
          aria-label={t('server.sortByName')}
          aria-pressed={sortByName}
          style={{ width: 30, height: 30, color: sortByName ? 'var(--hub-accent)' : undefined }}
          onClick={() => {
            setSortByName((value) => !value);
            setCurrentPage(1);
          }}
        >
          <ArrowDownAZ size={16} aria-hidden />
        </button>

        <div className="ml-auto hub-mono text-[12px]" style={{ color: 'var(--hub-ink-3)' }}>
          {clientPagination.total}/{allServers.length}
        </div>
      </div>

      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3 px-4 py-1.5 rounded-lg"
        style={{ background: selected.size ? 'var(--hub-accent-soft)' : 'transparent' }}
      >
        <label className="hub-checkbox-label">
          <input
            type="checkbox"
            disabled={deleting || visibleServers.length === 0}
            checked={
              visibleServers.length > 0 &&
              visibleServers.every((server) => selected.has(server.name))
            }
            onChange={(event) =>
              setSelected((current) => {
                const next = new Set(current);
                visibleServers.forEach((server) =>
                  event.target.checked ? next.add(server.name) : next.delete(server.name),
                );
                return next;
              })
            }
          />
          {t('serverBatch.selectPage')}
        </label>
        <span className="hub-sub text-sm">
          {t('serverBatch.selected', { count: selected.size })}
        </span>
        {selected.size > 0 && (
          <button
            className="hub-btn danger ml-auto"
            disabled={deleting}
            onClick={() => setConfirmBatchDelete(true)}
          >
            {t('serverBatch.delete')}
          </button>
        )}
        {batchResult && (
          <span role="status" className="text-sm">
            {batchResult}
          </span>
        )}
      </div>
      <ConfirmDialog
        isOpen={confirmBatchDelete}
        variant="danger"
        title={t('serverBatch.delete')}
        confirmText={deleting ? t('serverBatch.deleting') : t('serverBatch.delete')}
        confirmDisabled={deleting}
        onClose={() => {
          if (!deleting) setConfirmBatchDelete(false);
        }}
        onConfirm={deleteSelected}
        message={
          <div>
            <p>{t('serverBatch.confirm', { count: selected.size })}</p>
            <ul className="mt-3 max-h-60 overflow-y-auto">
              {[...selected].map((name) => {
                const identity = splitServerKey(name);
                return (
                  <li key={name}>
                    {identity.catalog || t('catalog.public')} / {identity.name}
                  </li>
                );
              })}
            </ul>
          </div>
        }
      />
      {/* List */}
      {isLoading && servers.length === 0 ? (
        <div className="hub-card p-6 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <RefreshCw size={20} className="animate-spin" style={{ color: 'var(--hub-ink-3)' }} />
            <p style={{ color: 'var(--hub-ink-3)' }}>{t('app.loading')}</p>
          </div>
        </div>
      ) : visibleServers.length === 0 ? (
        <div className="hub-card p-10 text-center" style={{ color: 'var(--hub-ink-3)' }}>
          <p>{servers.length === 0 ? t('app.noServers') : t('market.noServers')}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col">
            {visibleServers.map((server) => (
              <ServerCard
                key={server.name}
                server={server}
                relayReady={relayReady}
                relayMode={relayModes[server.name]}
                selected={selected.has(server.name)}
                selectionDisabled={deleting}
                onSelect={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(server.name);
                    else next.delete(server.name);
                    return next;
                  })
                }
                cost={serverCosts.find((c) => c.name === server.name)}
                onRemove={handleServerRemove}
                onEdit={handleEditClick}
                onDuplicate={handleDuplicateClick}
                isDuplicating={duplicatingServer === server.name}
                onToggle={handleServerToggle}
                onVisibilityChange={handleServerVisibilityChange}
                onRefresh={triggerRefresh}
                onReload={handleServerReload}
                onReinstall={handleServerReinstall}
                onOAuthDisconnect={handleServerOAuthDisconnect}
              />
            ))}
          </div>

          <div className="flex items-center mt-4 text-[12px]" style={{ color: 'var(--hub-ink-3)' }}>
            <div className="flex-[2]">
              {t('common.showing', {
                start: (clientPagination.page - 1) * clientPagination.limit + 1,
                end: Math.min(
                  clientPagination.page * clientPagination.limit,
                  clientPagination.total,
                ),
                total: clientPagination.total,
              })}
            </div>
            <div className="flex-[4] flex justify-center">
              {clientPagination.totalPages > 1 && (
                <Pagination
                  currentPage={clientPagination.page}
                  totalPages={clientPagination.totalPages}
                  onPageChange={setCurrentPage}
                  disabled={isLoading}
                />
              )}
            </div>
            <div className="flex-[2] flex items-center justify-end gap-2">
              <label htmlFor="perPage">{t('common.itemsPerPage')}:</label>
              <select
                id="perPage"
                value={serversPerPage}
                onChange={(e) => setServersPerPage(Number(e.target.value))}
                disabled={isLoading}
                className="hub-input"
                style={{ height: 26, width: 70, padding: '0 6px', fontSize: 12 }}
              >
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
            </div>
          </div>
        </>
      )}

      {editingServer && (
        <EditServerForm
          server={editingServer}
          onEdit={() => {
            setEditingServer(null);
            triggerRefresh();
          }}
          onCancel={() => setEditingServer(null)}
        />
      )}
      {showMcpbUpload && (
        <McpbUploadForm
          catalog={catalog === '*' ? '' : catalog}
          onSuccess={() => {
            setShowMcpbUpload(false);
            triggerRefresh();
          }}
          onCancel={() => setShowMcpbUpload(false)}
        />
      )}
      {showJsonImport && (
        <JSONImportForm
          defaultCatalog={catalog === '*' ? '' : catalog}
          onSuccess={() => {
            setShowJsonImport(false);
            triggerRefresh();
          }}
          onCancel={() => setShowJsonImport(false)}
        />
      )}
    </div>
  );
};

export default ServersPage;
