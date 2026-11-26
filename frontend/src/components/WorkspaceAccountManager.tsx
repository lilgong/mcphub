import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useServerData } from '../hooks/useServerData';
import { apiDelete, apiGet, apiPut, type ApiResponse } from '../utils/fetchInterceptor';
import type { WorkspaceSummary, WorkspaceCredentialSchema } from '../../../src/types/workspace';
import {
  workspaceAccountSections,
  loadWorkspaceAccountDefinitions,
  type WorkspaceAccountDefinition,
} from '../../../src/utils/workspaceAccountSections';
import { splitServerKey } from '../../../src/utils/catalog';
import ServerAccountEditor from './ServerAccountEditor';
import WorkspaceRunStatus from './WorkspaceRunStatus';
import WorkspaceEnabledSwitch from './WorkspaceEnabledSwitch';

export default function WorkspaceAccountManager({
  onDirtyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const [search] = useSearchParams();
  const { allServers, isLoading, error: serverError } = useServerData({ refreshOnMount: true });
  const [accounts, setAccounts] = useState<WorkspaceSummary[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [catalog, setCatalog] = useState(search.get('catalog') || '');
  const [name, setName] = useState(search.get('account') || '');
  const [expanded, setExpanded] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [grants, setGrants] = useState<string[]>([]);
  const [editingPermissions, setEditingPermissions] = useState(false);
  const [definitionRefresh, setDefinitionRefresh] = useState(0);
  const [definitions, setDefinitions] = useState<{
    key: string;
    servers: WorkspaceAccountDefinition[];
    failed: string[];
  }>({ key: '', servers: [], failed: [] });
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const reload = useCallback(async () => {
    const [profiles, permissions] = await Promise.all([
      apiGet<ApiResponse<WorkspaceSummary[]>>('/workspace-credentials'),
      apiGet<ApiResponse<{ id: string; name: string }[]>>('/user-groups'),
    ]);
    if (!profiles.success || !permissions.success)
      throw new Error(t('workspaceCredentials.failed'));
    setAccounts(profiles.data || []);
    setGroups(permissions.data || []);
  }, [t]);
  useEffect(() => {
    void reload()
      .catch(() => setMessage(t('workspaceCredentials.failed')))
      .finally(() => setLoading(false));
  }, [reload, t]);
  const catalogs = useMemo(
    () =>
      [
        ...new Set([
          ...accounts.map((account) => account.catalog),
          ...allServers.map((server) => splitServerKey(server.name).catalog).filter(Boolean),
        ]),
      ].sort(),
    [accounts, allServers],
  );
  const currentCatalog = catalog || catalogs[0] || '';
  const definitionKey = JSON.stringify(
    allServers
      .map((server) => server.name)
      .filter((server) => splitServerKey(server).catalog === currentCatalog)
      .sort(),
  );
  useEffect(() => {
    let active = true;
    void loadWorkspaceAccountDefinitions(JSON.parse(definitionKey) as string[], (server) =>
      apiGet<ApiResponse<{ schema: WorkspaceCredentialSchema }>>(
        `/servers/${encodeURIComponent(server)}/accounts`,
      ),
    ).then((result) => {
      if (active) setDefinitions({ key: definitionKey, ...result });
    });
    return () => {
      active = false;
    };
  }, [definitionKey, definitionRefresh]);
  const definitionsLoading = isLoading || definitions.key !== definitionKey;
  const choices = accounts
    .filter((account) => account.catalog === currentCatalog)
    .sort((a, b) => a.name.localeCompare(b.name));
  const selected = choices.find((account) => account.name === name) || choices[0];
  const sections = workspaceAccountSections(definitions.servers, currentCatalog, selected);
  const canLeave = () => !dirty || window.confirm(t('startupAccounts.discard'));
  const reset = () => {
    setExpanded('');
    setDirty(false);
    setMessage('');
    setCreating(false);
    setEditingPermissions(false);
  };
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const saveAccount = async () => {
    const accountName = creating ? newName.trim() : selected?.name;
    if (!accountName || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(accountName)) {
      setMessage(t('startupAccounts.invalidName'));
      return;
    }
    if (creating && choices.some((account) => account.name === accountName)) {
      setMessage(t('startupAccounts.exists'));
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result = await apiPut<ApiResponse>(
        `/workspace-credentials/${encodeURIComponent(currentCatalog)}/${encodeURIComponent(accountName)}`,
        {
          revision: creating ? undefined : selected?.revision,
          allowedGroupIds: grants,
          values: {},
          files: {},
        },
      );
      if (!result.success) throw new Error(result.message || t('workspaceCredentials.failed'));
      await reload();
      reset();
      setName(accountName);
      setMessage(t('workspaceCredentials.saved'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('workspaceCredentials.failed'));
    } finally {
      setBusy(false);
    }
  };
  const removeAccount = async () => {
    if (
      !selected ||
      !window.confirm(
        t('startupAccounts.deleteConfirm', {
          name: selected.name,
          catalog: currentCatalog,
        }),
      )
    )
      return;
    setBusy(true);
    setMessage('');
    try {
      const result = await apiDelete<ApiResponse>(
        `/workspace-credentials/${encodeURIComponent(currentCatalog)}/${encodeURIComponent(selected.name)}`,
      );
      if (!result.success) throw new Error(result.message || t('workspaceCredentials.failed'));
      await reload();
      reset();
      setName('');
      setMessage(t('startupAccounts.deleted'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('workspaceCredentials.failed'));
    } finally {
      setBusy(false);
    }
  };
  const names = (servers: string[]) =>
    servers.map((server) => splitServerKey(server).name).join('、');
  return (
    <section className="space-y-5">
      <p className="hub-sub">{t('accountManager.description')}</p>
      <div className="hub-account-toolbar">
        <label className="hub-field">
          <span className="hub-label">{t('workspaceCredentials.catalog')}</span>
          <select
            className="hub-input"
            value={currentCatalog}
            disabled={busy || loading}
            onChange={(event) => {
              if (!canLeave()) return;
              reset();
              setCatalog(event.target.value);
              setName('');
            }}
          >
            {!catalogs.length && <option value="">{t('accountManager.noSpaces')}</option>}
            {catalogs.map((space) => (
              <option key={space} value={space}>
                {space}
              </option>
            ))}
          </select>
        </label>
        <label className="hub-field">
          <span className="hub-label">{t('accountManager.account')}</span>
          <select
            className="hub-input"
            value={selected?.name || ''}
            disabled={busy || loading || !choices.length}
            onChange={(event) => {
              if (!canLeave()) return;
              reset();
              setName(event.target.value);
            }}
          >
            {!choices.length && <option value="">{t('accountManager.noAccounts')}</option>}
            {choices.map((account) => (
              <option key={account.name} value={account.name}>
                {account.name}
                {account.enabled === false ? ` · ${t('workspaceCredentials.disabled')}` : ''}
                {account.busy ? ` · ${t('workspaceCredentials.inUse')}` : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="hub-btn"
          disabled={busy || !currentCatalog || loading}
          onClick={() => {
            if (!canLeave()) return;
            reset();
            setCreating(true);
            setNewName('');
            setGrants([]);
          }}
        >
          <Plus size={15} />
          {t('accountManager.new')}
        </button>
        <button
          type="button"
          className="hub-btn"
          disabled={busy || loading}
          aria-label={t('accountManager.refresh')}
          onClick={() => {
            if (!canLeave()) return;
            reset();
            setDefinitionRefresh((current) => current + 1);
            void reload().catch(() => setMessage(t('workspaceCredentials.failed')));
          }}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      {(creating || editingPermissions) && (
        <form
          className="hub-account-profile space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void saveAccount();
          }}
        >
          {creating && (
            <label className="hub-field">
              <span className="hub-label">{t('accountManager.account')}</span>
              <input
                className="hub-input"
                placeholder="account-b"
                required
                maxLength={80}
                value={newName}
                disabled={busy}
                onChange={(event) => {
                  setNewName(event.target.value);
                  setDirty(true);
                }}
              />
            </label>
          )}
          <div className="space-y-3">
            <p className="hub-label">{t('workspaceCredentials.groups')}</p>
            <p className="hub-config-note">{t('workspaceCredentials.groupHelp')}</p>
            <div className="flex flex-wrap gap-4">
              {groups.map((group) => (
                <label className="hub-checkbox-label" key={group.id}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={grants.includes(group.id)}
                    onChange={(event) => {
                      setDirty(true);
                      setGrants((current) =>
                        event.target.checked
                          ? [...current, group.id]
                          : current.filter((id) => id !== group.id),
                      );
                    }}
                  />
                  {group.name}
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-3">
            <button className="hub-btn primary" type="submit" disabled={busy}>
              {t('accountManager.save')}
            </button>
            <button
              className="hub-btn"
              type="button"
              disabled={busy}
              onClick={() => {
                if (canLeave()) reset();
              }}
            >
              {t('accountManager.cancel')}
            </button>
          </div>
        </form>
      )}
      {!creating && !editingPermissions && selected && (
        <>
          <div className="hub-account-overview">
            <div>
              <h2 className="hub-editor-heading !mb-1">{selected.name}</h2>
              <p className="hub-config-note">
                {definitionsLoading
                  ? t('credentials.loading')
                  : t('accountManager.related', {
                      count: sections.reduce((count, section) => count + section.servers.length, 0),
                    })}
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <WorkspaceEnabledSwitch
                workspace={selected}
                disabled={busy || dirty}
                onChanged={reload}
              />
              <button
                type="button"
                className="hub-btn"
                disabled={selected.busy || busy}
                onClick={() => {
                  if (!canLeave()) return;
                  reset();
                  setGrants(selected.allowedGroupIds);
                  setEditingPermissions(true);
                }}
              >
                {t('accountManager.permissions')}
              </button>
              <button
                type="button"
                className="hub-btn danger"
                disabled={selected.busy || busy || dirty}
                onClick={() => void removeAccount()}
              >
                <Trash2 size={14} />
                {t('accountManager.delete')}
              </button>
            </div>
          </div>
          <WorkspaceRunStatus workspace={selected} onRecovered={reload} />
          {definitions.failed.length > 0 && !definitionsLoading && (
            <p role="alert" className="hub-config-note">
              {t('accountManager.loadFailed', { servers: names(definitions.failed) })}
            </p>
          )}
          {definitionsLoading ? (
            <p className="hub-sub">{t('credentials.loading')}</p>
          ) : serverError ? (
            <p role="alert">{serverError}</p>
          ) : !sections.length ? (
            <p className="hub-sub">{t('accountManager.noDeclarations')}</p>
          ) : (
            <div className="hub-account-sections">
              {sections.map((section) => {
                const active = expanded === section.id;
                const title =
                  section.servers.length > 1 && section.schema.files?.length === 1
                    ? section.schema.files[0].label || names(section.servers)
                    : names(section.servers);
                return (
                  <div key={section.id}>
                    <button
                      type="button"
                      className="hub-account-section-toggle"
                      aria-expanded={active}
                      aria-controls={`account-section-${encodeURIComponent(section.server)}`}
                      disabled={busy}
                      onClick={() => {
                        if (!canLeave()) return;
                        setDirty(false);
                        setExpanded(active ? '' : section.id);
                      }}
                    >
                      <div className="min-w-0">
                        <span className="font-medium break-words">{title}</span>
                        {section.servers.length > 1 && (
                          <p className="hub-config-note">
                            {t('accountManager.shared', { servers: names(section.servers) })}
                          </p>
                        )}
                        {!section.schema.enabled && (
                          <p className="hub-config-note">{t('accountManager.disabled')}</p>
                        )}
                      </div>
                      <span className="hub-account-section-status">
                        {t(
                          section.configured
                            ? 'accountManager.configured'
                            : 'accountManager.missing',
                        )}
                        <ChevronRight size={16} aria-hidden className={active ? 'rotate-90' : ''} />
                      </span>
                    </button>
                    {active && (
                      <div
                        className="hub-account-section-body"
                        id={`account-section-${encodeURIComponent(section.server)}`}
                      >
                        <ServerAccountEditor
                          key={`${currentCatalog}/${selected.name}/${section.server}`}
                          server={section.server}
                          schema={section.schema}
                          fixedAccount={selected.name}
                          onSaved={reload}
                          onDirtyChange={setDirty}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {!selected && !creating && !loading && <p className="hub-sub">{t('accountManager.empty')}</p>}
      {loading && <p className="hub-sub">{t('credentials.loading')}</p>}
      {message && (
        <p role="status" className="text-sm text-[var(--hub-ink-2)]">
          {message}
        </p>
      )}
    </section>
  );
}
