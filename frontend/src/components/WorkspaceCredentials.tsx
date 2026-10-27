import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiDelete, apiGet, apiPut, apiPost, type ApiResponse } from '../utils/fetchInterceptor';

interface Workspace {
  catalog: string;
  name: string;
  revision: string;
  allowedGroupIds: string[];
  fields: string[];
  files: string[];
  connections: Record<string, Record<string, string>>;
  busy: boolean;
  expired?: boolean;
}
/** Write-only account material: discovery exposes field/file names, never values. */
export default function WorkspaceCredentials() {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<Workspace | null>(null);
  const [catalog, setCatalog] = useState('');
  const [name, setName] = useState('');
  const [grants, setGrants] = useState<string[]>([]);
  const [fields, setFields] = useState<{ name: string; value: string; visible: boolean }[]>([]);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [directory, setDirectory] = useState('configs');
  const [connections, setConnections] = useState<Record<string, Record<string, string>>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    const [profiles, callingGroups] = await Promise.all([
      apiGet<ApiResponse<Workspace[]>>('/workspace-credentials'),
      apiGet<ApiResponse<{ id: string; name: string }[]>>('/user-groups'),
    ]);
    if (!profiles.success) throw new Error(profiles.message || t('workspaceCredentials.failed'));
    setWorkspaces(profiles.data || []);
    setGroups(callingGroups.data || []);
  }, [t]);
  useEffect(() => {
    void reload().catch(() => setMessage(t('workspaceCredentials.failed')));
  }, [reload, t]);
  const edit = (workspace: Workspace | null) => {
    setSelected(workspace);
    setCatalog(workspace?.catalog || '');
    setName(workspace?.name || '');
    setGrants(workspace?.allowedGroupIds || []);
    setFields((workspace?.fields || []).map((name) => ({ name, value: '', visible: false })));
    setFiles({});
    setConnections(workspace?.connections || {});
    setMessage('');
  };
  const importTemplate = async (file?: File) => {
    if (!file) return;
    try {
      const template = JSON.parse(await file.text());
      if (!template.values || typeof template.values !== 'object' || Array.isArray(template.values))
        throw new Error('Invalid workspace template');
      const names = Object.keys(template.values);
      if (names.length > 256 || names.some((name) => !/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(name)))
        throw new Error('Invalid workspace fields');
      if (!selected && typeof template.catalog === 'string') setCatalog(template.catalog);
      setFields((current) => [
        ...current,
        ...names
          .filter((name) => !current.some((field) => field.name === name))
          .map((name) => ({ name, value: '', visible: false })),
      ]);
      setConnections(template.connections || {});
    } catch {
      setMessage(t('workspaceCredentials.failed'));
    }
  };
  const save = async (remove = false) => {
    setBusy(true);
    setMessage('');
    try {
      const path = `/workspace-credentials/${encodeURIComponent(catalog)}/${encodeURIComponent(name)}`;
      const response = remove
        ? await apiDelete<ApiResponse>(path)
        : await apiPut<ApiResponse>(path, {
            revision: selected?.revision,
            allowedGroupIds: grants,
            files,
            connections,
            values: Object.fromEntries(
              fields
                .filter((field) => field.name && field.value)
                .map((field) => [field.name, field.value]),
            ),
          });
      if (!response.success) throw new Error(response.message || t('workspaceCredentials.failed'));
      edit(null);
      await reload();
      setMessage(t('workspaceCredentials.saved'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('workspaceCredentials.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('workspaceCredentials.title')}</h2>
        <button className="hub-btn" onClick={() => edit(null)}>
          {t('workspaceCredentials.new')}
        </button>
      </div>
      <p className="hub-sub">{t('workspaceCredentials.description')}</p>
      <div className="flex flex-wrap gap-2">
        {workspaces.map((workspace) => (
          <button
            key={`${workspace.catalog}/${workspace.name}`}
            className="hub-btn"
            onClick={() => edit(workspace)}
          >
            {workspace.catalog} · {workspace.name}
            {workspace.busy ? ` · ${t('workspaceCredentials.inUse')}` : ''}
          </button>
        ))}
      </div>
      <form
        className="hub-card p-5 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-2 text-sm">
            {t('workspaceCredentials.catalog')}
            <input
              className="hub-input"
              required
              disabled={!!selected}
              value={catalog}
              onChange={(event) => setCatalog(event.target.value)}
            />
          </label>
          <label className="block space-y-2 text-sm">
            {t('workspaceCredentials.name')}
            <input
              className="hub-input"
              required
              disabled={!!selected}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">{t('workspaceCredentials.groups')}</p>
          <p className="text-xs text-[var(--hub-ink-3)]">{t('workspaceCredentials.groupHelp')}</p>
          <div className="flex flex-wrap gap-4">
            {groups.map((group) => (
              <label key={group.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={grants.includes(group.id)}
                  onChange={(event) =>
                    setGrants((current) =>
                      event.target.checked
                        ? [...current, group.id]
                        : current.filter((id) => id !== group.id),
                    )
                  }
                />
                {group.name}
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="hub-btn cursor-pointer">
            {t('workspaceCredentials.preset')}
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => void importTemplate(event.target.files?.[0])}
            />
          </label>
          <button
            type="button"
            className="hub-btn"
            onClick={() => setFields([...fields, { name: '', value: '', visible: false }])}
          >
            {t('workspaceCredentials.addField')}
          </button>
        </div>
        <p className="text-xs text-[var(--hub-ink-3)]">{t('workspaceCredentials.writeOnly')}</p>
        <div className="space-y-3">
          {fields.map((field, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <input
                className="hub-input"
                aria-label={t('workspaceCredentials.field')}
                value={field.name}
                onChange={(event) =>
                  setFields(
                    fields.map((item, i) =>
                      i === index ? { ...item, name: event.target.value } : item,
                    ),
                  )
                }
              />
              <input
                className="hub-input"
                aria-label={field.name || t('workspaceCredentials.value')}
                autoComplete="new-password"
                type={field.visible ? 'text' : 'password'}
                value={field.value}
                placeholder={
                  selected?.fields.includes(field.name) ? t('workspaceCredentials.keep') : ''
                }
                onChange={(event) =>
                  setFields(
                    fields.map((item, i) =>
                      i === index ? { ...item, value: event.target.value } : item,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="hub-btn"
                onClick={() =>
                  setFields(
                    fields.map((item, i) =>
                      i === index ? { ...item, visible: !item.visible } : item,
                    ),
                  )
                }
              >
                {t(field.visible ? 'workspaceCredentials.hide' : 'workspaceCredentials.show')}
              </button>
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <p className="text-sm font-medium">{t('workspaceCredentials.files')}</p>
          <p className="text-xs text-[var(--hub-ink-3)]">{t('workspaceCredentials.fileHelp')}</p>
          <label className="block space-y-2 text-sm">
            {t('workspaceCredentials.directory')}
            <input
              className="hub-input"
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
            />
          </label>
          <label className="hub-btn cursor-pointer inline-flex">
            {t('workspaceCredentials.upload')}
            <input
              type="file"
              multiple
              className="hidden"
              onChange={async (event) => {
                try {
                  const entries = await Promise.all(
                    Array.from(event.target.files || []).map(
                      async (file) =>
                        [
                          `${directory.replace(/\/$/, '')}/${file.name}`,
                          await file.text(),
                        ] as const,
                    ),
                  );
                  setFiles((current) => ({ ...current, ...Object.fromEntries(entries) }));
                } catch {
                  setMessage(t('workspaceCredentials.failed'));
                }
              }}
            />
          </label>
          <ul className="space-y-1 break-all text-xs text-[var(--hub-ink-3)]">
            {[...new Set([...(selected?.files || []), ...Object.keys(files)])].map((path) => (
              <li key={path}>
                {path}
                {path in files ? ` · ${t('workspaceCredentials.pending')}` : ''}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="hub-btn primary" disabled={busy || selected?.busy}>
            {t('workspaceCredentials.save')}
          </button>
          {selected && (
            <button
              type="button"
              className="hub-btn danger"
              disabled={busy || selected.busy}
              onClick={() => void save(true)}
            >
              {t('workspaceCredentials.delete')}
            </button>
          )}
        </div>
        {selected?.expired && (
          <button
            type="button"
            className="hub-btn danger"
            onClick={async () => {
              if (!window.confirm(t('workspaceCredentials.recoveryConfirm'))) return;
              const result = await apiPost<ApiResponse>(
                `/workspace-credentials/${encodeURIComponent(catalog)}/${encodeURIComponent(name)}/release`,
              );
              if (result.success) {
                edit(null);
                await reload();
              } else setMessage(result.message || t('workspaceCredentials.failed'));
            }}
          >
            {t('workspaceCredentials.recover')}
          </button>
        )}
        {message && (
          <p role="status" className="text-sm text-[var(--hub-ink-2)]">
            {message}
          </p>
        )}
      </form>
    </section>
  );
}
