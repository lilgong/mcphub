import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Check, ChevronRight, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceCredentialSchema, WorkspaceSummary } from '../../../src/types/workspace';
import { apiDelete, apiGet, apiPut, type ApiResponse } from '../utils/fetchInterceptor';
import SecretInput from './SecretInput';
import { splitServerKey } from '../../../src/utils/catalog';
import AccountDocumentEditor from './AccountDocumentEditor';
import { initialDocument, validateDocument } from '../../../src/utils/workspaceDocuments';

export default function ServerAccountEditor({
  server,
  schema,
}: {
  server: string;
  schema: WorkspaceCredentialSchema;
}) {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<WorkspaceSummary[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState('');
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, string>>({});
  const [savedFiles, setSavedFiles] = useState<string[]>([]);
  const [grants, setGrants] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [revision, setRevision] = useState<string>();
  const [edited, setEdited] = useState(false);
  const loadVersion = useRef(0);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!message || failed) return;
    const timer = window.setTimeout(() => setMessage(''), 3000);
    return () => window.clearTimeout(timer);
  }, [message, failed]);
  const loaded = useRef(false);
  const selectedAccount = accounts.find((account) => account.name === selected);
  const endpoint = `/servers/${encodeURIComponent(server)}/accounts`;
  const reload = useCallback(async () => {
    const [profiles, permissions] = await Promise.all([
      apiGet<ApiResponse<{ accounts: WorkspaceSummary[] }>>(endpoint),
      apiGet<ApiResponse<{ id: string; name: string }[]>>('/user-groups'),
    ]);
    if (!profiles.success) throw new Error(profiles.message || t('startupAccounts.failed'));
    const next = profiles.data?.accounts || [];
    setAccounts(next);
    setGroups(permissions.data || []);
    if (!loaded.current) {
      loaded.current = true;
      if (next.length) {
        setSelected(next[0].name);
        setGrants(next[0].allowedGroupIds);
      } else setCreating(true);
    }
    return next;
  }, [endpoint, t]);
  useEffect(() => {
    void reload().catch(() => {
      setFailed(true);
      setMessage(t('startupAccounts.failed'));
    });
  }, [reload, t]);
  const dirty = edited;
  const loadAccount = useCallback(
    async (account: string) => {
      const version = ++loadVersion.current;
      setReading(true);
      setMessage('');
      setFailed(false);
      setValues({});
      setFiles({});
      setRevision(undefined);
      setSavedFiles([]);
      try {
        const defaults = Object.fromEntries(
          (schema.files || [])
            .filter((file) => !file.directory)
            .map((file) => [file.path, initialDocument(file)]),
        );
        const defaultValues = Object.fromEntries(
          (schema.values || []).map((field) => [field.name, field.default || '']),
        );
        if (!account) {
          setValues(defaultValues);
          setFiles(defaults);
        } else {
          const result = await apiGet<
            ApiResponse<{
              values: Record<string, string>;
              files: Record<string, string>;
              revision: string;
              allowedGroupIds: string[];
            }>
          >(`${endpoint}/${encodeURIComponent(account)}`);
          if (version !== loadVersion.current) return;
          if (!result.success || !result.data) throw new Error(t('startupAccounts.failed'));
          setValues({ ...defaultValues, ...result.data.values });
          setFiles({ ...defaults, ...result.data.files });
          setRevision(result.data.revision);
          setGrants(result.data.allowedGroupIds);
          setSavedFiles(Object.keys(result.data.files));
        }
        setEdited(false);
      } catch {
        if (version !== loadVersion.current) return;
        setFailed(true);
        setMessage(t('startupAccounts.failed'));
      } finally {
        if (version === loadVersion.current) setReading(false);
      }
    },
    [endpoint, schema.files, schema.values, t],
  );
  useEffect(() => {
    if (selected || creating) void loadAccount(creating ? '' : selected);
    return () => {
      loadVersion.current++;
    };
  }, [selected, creating, loadAccount]);
  const change = (account?: WorkspaceSummary) => {
    if (account && !creating && selected === account.name) {
      setExpanded((current) => !current);
      return;
    }
    if (dirty && !window.confirm(t('startupAccounts.discard'))) return;
    setSelected(account?.name || '');
    setCreating(!account);
    setExpanded(true);
    setName('');
    setGrants(account?.allowedGroupIds || []);
    setEdited(false);
    setMessage('');
  };
  const disabled = busy || reading || (!creating && (!revision || !!selectedAccount?.busy));
  const save = async () => {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      const account = creating ? name.trim() : selected;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(account))
        throw new Error(t('startupAccounts.invalidName'));
      if (creating && accounts.some((entry) => entry.name === account))
        throw new Error(t('startupAccounts.exists'));
      if (
        (schema.files || []).some(
          (file) => files[file.path] !== undefined && !validateDocument(file, files[file.path]),
        )
      )
        throw new Error(t('startupAccounts.invalidJson'));
      const result = await apiPut<ApiResponse>(`${endpoint}/${encodeURIComponent(account)}`, {
        revision: creating ? undefined : revision,
        allowedGroupIds: grants,
        values,
        files: Object.fromEntries(
          Object.entries(files).filter(([path, content]) => {
            const entry = schema.files?.find((file) => file.path === path);
            return savedFiles.includes(path) || !entry || content !== initialDocument(entry);
          }),
        ),
      });
      if (!result.success) throw new Error(result.message || t('startupAccounts.failed'));
      await reload();
      setCreating(false);
      setSelected(account);
      setEdited(false);
      await loadAccount(account);
      setMessage(t('startupAccounts.saved'));
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : t('startupAccounts.failed'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (creating || disabled || !selected) return;
    const catalog = splitServerKey(server).catalog;
    if (
      !catalog ||
      !window.confirm(t('startupAccounts.deleteConfirm', { name: selected, catalog }))
    )
      return;
    setBusy(true);
    setFailed(false);
    setMessage('');
    try {
      const result = await apiDelete<ApiResponse>(
        `/workspace-credentials/${encodeURIComponent(catalog)}/${encodeURIComponent(selected)}`,
      );
      if (!result.success) throw new Error(result.message || t('startupAccounts.failed'));
      await reload();
      loadVersion.current++;
      setSelected('');
      setCreating(false);
      setExpanded(false);
      setName('');
      setValues({});
      setFiles({});
      setSavedFiles([]);
      setRevision(undefined);
      setReading(false);
      setGrants([]);
      setEdited(false);
      setMessage(t('startupAccounts.deleted'));
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : t('startupAccounts.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5">
      <div>
        <h3 className="hub-editor-heading">{t('startupAccounts.title')}</h3>
        <p className="hub-config-note">{t('startupAccounts.help')}</p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="hub-label">{t('startupAccounts.choose')}</p>
        <button
          type="button"
          className="hub-btn"
          disabled={busy || creating}
          onClick={() => change()}
        >
          <Plus size={15} aria-hidden />
          {t('startupAccounts.new')}
        </button>
      </div>
      {accounts.length > 0 && (
        <div
          className="hub-account-list hub-account-picker"
          role="group"
          aria-label={t('startupAccounts.choose')}
        >
          {accounts.map((account) => (
            <button
              key={account.name}
              type="button"
              className={`hub-account-row ${expanded && !creating && selected === account.name ? 'is-active' : ''}`}
              aria-expanded={expanded && !creating && selected === account.name}
              aria-label={t('startupAccounts.editAccount', { name: account.name })}
              disabled={busy}
              onClick={() => change(account)}
            >
              <span className="hub-account-name">{account.name}</span>
              <span className="hub-account-meta">
                {account.busy
                  ? t('workspaceCredentials.inUse')
                  : expanded && !creating && selected === account.name
                    ? t('startupAccounts.editing')
                    : ''}
              </span>
              <ChevronRight
                size={16}
                aria-hidden
                className={expanded && !creating && selected === account.name ? 'rotate-90' : ''}
              />
            </button>
          ))}
        </div>
      )}
      {(creating || selected) && (
        <div className="hub-account-profile space-y-5" hidden={!expanded}>
          <p className="hub-account-profile-title">
            {creating ? t('startupAccounts.new') : selected}
          </p>
          {creating && (
            <label className="hub-field">
              <span className="hub-label">{t('startupAccounts.name')}</span>
              <input
                className="hub-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="account-a"
                maxLength={80}
                disabled={busy}
              />
            </label>
          )}
          {selectedAccount?.busy && !creating && (
            <p className="hub-config-note">{t('startupAccounts.locked')}</p>
          )}
          <div className="space-y-4">
            {schema.values?.map((field) => (
              <label className="hub-field" key={field.name}>
                <span className="hub-label">
                  {field.label || field.name}
                  {field.label && field.label !== field.name && (
                    <span className="font-normal text-[var(--hub-ink-3)] break-all">
                      {' '}
                      ({field.name})
                    </span>
                  )}
                </span>
                <SecretInput
                  aria-label={field.label || field.name}
                  sensitive={field.secret !== false}
                  value={values[field.name] || ''}
                  className="hub-input"
                  secretLabel={field.label || field.name}
                  disabled={disabled}
                  autoComplete="off"
                  onChange={(event) => {
                    setEdited(true);
                    setValues({ ...values, [field.name]: event.target.value });
                  }}
                />
                {field.default !== undefined && (
                  <span className="hub-config-note break-all">
                    {t('startupAccounts.defaultValue', { value: field.default })}
                  </span>
                )}
                {field.description && <span className="hub-config-note">{field.description}</span>}
              </label>
            ))}
          </div>
          {schema.files
            ?.filter((entry) => !entry.directory)
            .map((entry) => (
              <AccountDocumentEditor
                key={`${selected}:${creating}:${entry.path}`}
                file={entry}
                value={files[entry.path] ?? initialDocument(entry)}
                disabled={disabled}
                onChange={(value) => {
                  setEdited(true);
                  setFiles((current) => ({ ...current, [entry.path]: value }));
                }}
              />
            ))}
          {schema.files
            ?.filter((entry) => entry.directory)
            .map((entry) => (
              <div className="space-y-3" key={entry.path}>
                <p className="hub-label">{entry.label || entry.path}</p>
                <p className="hub-config-note">{entry.description}</p>
                {Object.keys(files)
                  .filter(
                    (path) =>
                      path.startsWith(entry.path + '/') &&
                      !schema.files?.some((file) => !file.directory && file.path === path),
                  )
                  .map((path) => (
                    <AccountDocumentEditor
                      key={`${selected}:${path}`}
                      file={{ path, format: path.endsWith('.json') ? 'json' : 'text' }}
                      value={files[path]}
                      disabled={disabled}
                      onChange={(value) => {
                        setEdited(true);
                        setFiles((current) => ({ ...current, [path]: value }));
                      }}
                    />
                  ))}
              </div>
            ))}
          <div className="space-y-2">
            <p className="hub-label">{t('workspaceCredentials.groups')}</p>
            <p className="hub-config-note">{t('startupAccounts.grants')}</p>
            <div className="flex flex-wrap gap-4">
              {groups.map((group) => (
                <label className="hub-checkbox-label" key={group.id}>
                  <input
                    type="checkbox"
                    checked={grants.includes(group.id)}
                    disabled={disabled}
                    onChange={(event) => {
                      setEdited(true);
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
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="hub-btn"
              disabled={disabled}
              onClick={() => void save()}
            >
              <Check size={15} />
              {t('startupAccounts.save')}
            </button>
            {!creating && (
              <button
                type="button"
                className="hub-btn danger ml-auto"
                disabled={disabled}
                onClick={() => void remove()}
              >
                <Trash2 size={14} aria-hidden />
                {t('startupAccounts.delete')}
              </button>
            )}
          </div>
          <p className="hub-config-note">{t('startupAccounts.scope')}</p>
        </div>
      )}
      {message && (
        <p
          role="status"
          className={`text-sm ${failed ? 'text-[var(--hub-err)]' : 'text-[var(--hub-ink-3)]'}`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
