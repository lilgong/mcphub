import { splitServerKey } from '../../../src/utils/catalog';
import { filterGroupResources, selectVisibleGroupResources } from '../utils/groupResourceSelection';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Folder,
  Users,
  Plus,
  RefreshCw,
  ShieldCheck,
  Pencil,
  Trash2,
  KeyRound,
  Search,
  X,
  ChevronRight,
  ChevronDown,
  Copy,
  Check,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { copyText } from '../utils/clipboard';
import { apiGet, apiPost, apiPut, apiDelete, type ApiResponse } from '../utils/fetchInterceptor';
import type { User, BearerKey } from '../types';
import type { UserGroup, UserGroupResourceOption } from '../../../src/types/userGroup';
import AddUserForm from '../components/AddUserForm';
import EditUserForm from '../components/EditUserForm';
import SecretInput from '../components/SecretInput';
import DeleteDialog from '../components/ui/DeleteDialog';

export default function UsersPage() {
  const { t } = useTranslation();
  const { auth } = useAuth();
  const { showToast } = useToast();
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [servers, setServers] = useState<UserGroupResourceOption[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [keys, setKeys] = useState<BearerKey[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [resourceQuery, setResourceQuery] = useState('');
  const [resourceCatalog, setResourceCatalog] = useState('*');
  const [permissions, setPermissions] = useState<UserGroup>();
  const [editingGroup, setEditingGroup] = useState<UserGroup>();
  const [removingGroup, setRemovingGroup] = useState<UserGroup>();
  const [addingUser, setAddingUser] = useState(false);
  const [editingUser, setEditingUser] = useState<User>();
  const [removingUser, setRemovingUser] = useState<User>();
  const [newToken, setNewToken] = useState('');
  const [tokenCopied, setTokenCopied] = useState(false);
  useEffect(() => setTokenCopied(false), [newToken]);
  const [keyGroup, setKeyGroup] = useState<UserGroup>();
  const [removingKey, setRemovingKey] = useState<BearerKey>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const dialogOpen = !!permissions || !!editingGroup || !!newToken || !!keyGroup;
  useEffect(() => {
    if (!dialogOpen || removingKey) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = document.querySelector<HTMLElement>('.hub-directory-dialog');
    if (!dialog) return;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ),
      );
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!dialog.contains(document.activeElement)) focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        setPermissions(undefined);
        setEditingGroup(undefined);
        setNewToken('');
        setKeyGroup(undefined);
      }
      if (event.key === 'Tab') {
        const items = focusable();
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [dialogOpen, newToken, keyGroup, removingKey]);
  const load = useCallback(async () => {
    const replies = await Promise.all([
      apiGet<ApiResponse<UserGroup[]>>('/user-groups'),
      auth.user?.isAdmin
        ? apiGet<ApiResponse<User[]>>('/users')
        : Promise.resolve({ success: true, data: [] } as ApiResponse<User[]>),
      apiGet<ApiResponse<BearerKey[]>>('/auth/keys'),
    ]);
    if (replies.some((reply) => !reply.success || !reply.data))
      throw new Error(t('userGroups.failed'));
    setGroups(replies[0].data!);
    setUsers(replies[1].data!.sort((a, b) => a.username.localeCompare(b.username)));
    setKeys(replies[2].data!);
  }, [t, auth.user?.isAdmin]);
  useEffect(() => {
    if (auth.user?.username)
      void load()
        .catch(() => setError(t('userGroups.failed')))
        .finally(() => setLoading(false));
  }, [auth.user?.username, load, t]);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('userGroups.failed'));
    } finally {
      setBusy(false);
    }
  };
  const saveGroup = async (group: UserGroup) => {
    const { id, ...body } = group;
    const result = id
      ? await apiPut<ApiResponse<UserGroup>>(`/user-groups/${id}`, body)
      : await apiPost<ApiResponse<UserGroup>>('/user-groups', body);
    if (!result.success) throw new Error(result.message || t('userGroups.failed'));
    return result.data;
  };
  const createKey = (group?: UserGroup) =>
    run(async () => {
      const result = await apiPost<ApiResponse<BearerKey>>('/auth/keys', {
        name: group ? `${group.name} · ${t('userGroups.groupKey')}` : t('userGroups.sharedKey'),
        kind: group ? 'user' : 'system',
        owner: group?.owner,
        enabled: true,
        accessType: 'all',
        userGroupId: group?.id,
      });
      if (!result.success || !result.data)
        throw new Error(result.message || t('userGroups.failed'));
      setNewToken(result.data.token);
    });
  const newGroup = (owner = auth.user!.username) =>
    setEditingGroup({ id: '', name: '', owner, enabled: true, servers: [] });
  const ownerNames = [
    ...new Set([...users.map((user) => user.username), ...groups.map((group) => group.owner)]),
  ];
  const sections = auth.user?.isAdmin
    ? ownerNames
        .map((owner) => ({
          id: owner,
          user: users.find((user) => user.username === owner),
          groups: groups.filter((group) => group.owner === owner),
        }))
        .filter(
          (section) =>
            !query ||
            section.id.toLowerCase().includes(query.toLowerCase()) ||
            section.groups.some((group) => group.name.toLowerCase().includes(query.toLowerCase())),
        )
    : [
        {
          id: auth.user?.username ?? '',
          user: undefined,
          groups: groups.filter((group) => group.name.toLowerCase().includes(query.toLowerCase())),
        },
      ];
  const toggleGroup = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const expandGroup = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  const targetsFor = (server: UserGroupResourceOption) => server.targets;
  const openPermissions = async (group: UserGroup) => {
    setError('');
    try {
      const result = await apiGet<ApiResponse<UserGroupResourceOption[]>>(
        `/user-groups/resources?owner=${encodeURIComponent(group.owner)}`,
      );
      if (!result.success || !result.data)
        throw new Error(result.message || t('userGroups.failed'));
      setServers(result.data.sort((a, b) => a.name.localeCompare(b.name)));
      setPermissions({
        ...structuredClone(group),
        servers: group.servers.map((resource) => {
          const options =
            result.data!.find((server) => server.name === resource.name)?.targets ?? [];
          return {
            ...resource,
            ...(resource.targets === undefined && options.length
              ? { targets: options.map((target) => target.path) }
              : {}),
          };
        }),
      });
    } catch {
      setError(t('userGroups.failed'));
    }
  };
  const resourceCatalogs = [
    ...new Set(servers.map((server) => splitServerKey(server.name).catalog)),
  ]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const visibleResources = filterGroupResources(servers, resourceCatalog, resourceQuery);
  const selectVisible = (checked: boolean) =>
    setPermissions(
      (current) =>
        current && {
          ...current,
          servers: selectVisibleGroupResources(current.servers, visibleResources, checked),
        },
    );
  const resourceComplete = (server: UserGroupResourceOption) => {
    const resource = permissions?.servers.find((entry) => entry.name === server.name);
    return (
      !!resource &&
      (resource.targets === undefined ||
        targetsFor(server).every((target) => resource.targets?.includes(target.path)))
    );
  };
  const updateResource = (
    server: UserGroupResourceOption,
    targets: string[] | undefined,
    checked: boolean,
  ) => {
    if (!permissions) return;
    setPermissions({
      ...permissions,
      servers: [
        ...permissions.servers.filter((entry) => entry.name !== server.name),
        ...(checked ? [{ name: server.name, ...(targets === undefined ? {} : { targets }) }] : []),
      ],
    });
  };
  if (!auth.user) return null;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="hub-h1">
            {t(auth.user.isAdmin ? 'userGroups.title' : 'userDirectory.myGroups')}
          </h1>
          <p className="hub-sub">{t('userDirectory.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="hub-btn"
            disabled={busy}
            onClick={() => void run(async () => undefined)}
          >
            <RefreshCw size={14} />
            {t('common.refresh')}
          </button>
          {auth.user.isAdmin ? (
            <details className="relative">
              <summary className="hub-btn primary cursor-pointer list-none">
                <Plus size={14} />
                {t('common.add')}
              </summary>
              <div className="hub-card absolute right-0 top-full z-20 mt-2 min-w-40 p-1">
                <button
                  className="hub-btn ghost w-full justify-start"
                  disabled={busy}
                  onClick={(event) => {
                    event.currentTarget.closest('details')?.removeAttribute('open');
                    setAddingUser(true);
                  }}
                >
                  <Users size={14} />
                  {t('users.add')}
                </button>
                <button
                  className="hub-btn ghost w-full justify-start"
                  disabled={busy}
                  onClick={(event) => {
                    event.currentTarget.closest('details')?.removeAttribute('open');
                    newGroup();
                  }}
                >
                  <Folder size={14} />
                  {t('userDirectory.createGroup')}
                </button>
              </div>
            </details>
          ) : (
            <button className="hub-btn primary" disabled={busy} onClick={() => newGroup()}>
              <Plus size={14} />
              {t('userDirectory.createGroup')}
            </button>
          )}
        </div>
      </div>
      {error && !dialogOpen && (
        <p role="alert" className="text-sm text-[var(--hub-err)]">
          {error}
        </p>
      )}
      <section className="hub-card hub-contact-list" aria-busy={busy}>
        <div className="hub-contact-toolbar">
          <div className="hub-contact-total">
            {auth.user.isAdmin ? <Users size={16} /> : <Folder size={16} />}
            <span>
              {t(auth.user.isAdmin ? 'userDirectory.allUsers' : 'userDirectory.myGroups')}
            </span>
            <small>{auth.user.isAdmin ? users.length : groups.length}</small>
          </div>
          <div className="hub-directory-search">
            <Search size={14} />
            <input
              aria-label={t('userDirectory.searchOwnedGroups')}
              placeholder={t('userDirectory.searchOwnedGroups')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        {loading ? (
          <p className="hub-contact-empty">{t('app.loading')}</p>
        ) : (
          sections.map((section) => {
            const open = !auth.user!.isAdmin || !!query || !collapsed.has(section.id);
            return (
              <section key={section.id} className="hub-contact-group" data-owner={section.id}>
                {auth.user!.isAdmin && (
                  <div className="hub-contact-group-header">
                    <button
                      className="hub-contact-group-toggle"
                      aria-expanded={open}
                      onClick={() => toggleGroup(section.id)}
                    >
                      {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      <span>{section.id}</span>
                      <small>{section.groups.length}</small>
                      {section.user?.isAdmin && <span className="hub-tag">{t('users.admin')}</span>}
                    </button>
                    <div className="hub-contact-group-actions">
                      <button
                        className="hub-btn ghost sm"
                        disabled={busy || !section.user}
                        onClick={() => newGroup(section.id)}
                      >
                        <Plus size={13} />
                        {t('userDirectory.createGroup')}
                      </button>
                      {section.user && (
                        <button
                          className="hub-icon-btn sm"
                          disabled={busy}
                          aria-label={t('userDirectory.editUser', { name: section.id })}
                          onClick={() => setEditingUser(section.user)}
                        >
                          <Pencil size={13} />
                        </button>
                      )}
                      {section.user && section.id !== auth.user!.username && (
                        <button
                          className="hub-icon-btn sm"
                          disabled={busy}
                          aria-label={t('userDirectory.deleteUser', { name: section.id })}
                          onClick={() => setRemovingUser(section.user)}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {open && (
                  <div className="hub-contact-members">
                    {section.groups.map((group) => (
                      <div className="hub-contact-user" key={group.id} data-group-id={group.id}>
                        <Folder size={16} className="shrink-0 text-[var(--hub-ink-3)]" />
                        <div className="hub-contact-user-name">
                          <span>{group.name}</span>
                          <small>
                            {t('userGroups.serverCount', { count: group.servers.length })}
                            {group.description ? ` · ${group.description}` : ''}
                          </small>
                        </div>
                        {!group.enabled && <span className="hub-tag">{t('common.inactive')}</span>}
                        <div className="hub-contact-group-actions">
                          <button
                            className="hub-btn ghost sm"
                            disabled={busy}
                            aria-label={t('userDirectory.permissionsFor', { name: group.name })}
                            onClick={() => {
                              setResourceQuery('');
                              setResourceCatalog('*');
                              void openPermissions(group);
                            }}
                          >
                            <ShieldCheck size={13} />
                            {t('userDirectory.permissions')}
                          </button>
                          <button
                            className="hub-btn ghost sm"
                            disabled={busy}
                            aria-label={t('userDirectory.keyFor', { name: group.name })}
                            onClick={() => {
                              setError('');
                              setKeyGroup(group);
                            }}
                          >
                            <KeyRound size={14} />
                            {t('userDirectory.groupKeyButton')}
                          </button>
                          <button
                            className="hub-icon-btn sm"
                            disabled={busy}
                            aria-label={t('userDirectory.renameFor', { name: group.name })}
                            onClick={() => setEditingGroup(structuredClone(group))}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            className="hub-icon-btn sm"
                            disabled={busy}
                            aria-label={t('userDirectory.deleteGroupFor', { name: group.name })}
                            onClick={() => setRemovingGroup(group)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                    {!section.groups.length && (
                      <p className="hub-contact-empty">{t('userDirectory.noOwnedGroups')}</p>
                    )}
                  </div>
                )}
              </section>
            );
          })
        )}
      </section>
      {auth.user.isAdmin && (
        <div className="hub-directory-shared">
          <div>
            <span className="hub-label">{t('userGroups.sharedKey')}</span>
            <p className="hub-config-note">{t('userGroups.sharedHint')}</p>
          </div>
          <button className="hub-btn" disabled={busy} onClick={() => void createKey()}>
            <KeyRound size={14} />
            {t('userGroups.createSharedKey')}
          </button>
        </div>
      )}
      {auth.user.isAdmin && (
        <details className="hub-directory-advanced">
          <summary>{t('userDirectory.advancedRoutes')}</summary>
          <p className="hub-config-note">{t('userDirectory.routesHint')}</p>
          <Link className="hub-btn" to="/groups">
            {t('userDirectory.manageRoutes')}
          </Link>
        </details>
      )}
      {keyGroup && !newToken && !removingKey && (
        <div className="hub-directory-overlay">
          <section
            className="hub-directory-dialog compact"
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-keys-title"
          >
            <div className="hub-directory-dialog-header">
              <h2 id="group-keys-title" className="hub-card-title">
                {t('userDirectory.keyFor', { name: keyGroup.name })}
              </h2>
              <button
                className="hub-icon-btn"
                disabled={busy}
                aria-label={t('common.close')}
                onClick={() => setKeyGroup(undefined)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="hub-config-note">{t('userDirectory.groupKeyHint')}</p>
              {error && (
                <p role="alert" className="text-sm text-[var(--hub-err)]">
                  {error}
                </p>
              )}
              {keys
                .filter((key) => key.userGroupId === keyGroup.id)
                .map((key) => (
                  <div className="hub-group-key-row" key={key.id}>
                    <div>
                      <span>{key.name}</span>
                      <small className="hub-mono">{key.token}</small>
                    </div>
                    <label className="hub-checkbox-label">
                      <input
                        type="checkbox"
                        checked={key.enabled}
                        disabled={busy}
                        onChange={() =>
                          void run(async () => {
                            const result = await apiPut(`/auth/keys/${key.id}`, {
                              enabled: !key.enabled,
                            });
                            if (!result.success)
                              throw new Error(result.message || t('userGroups.failed'));
                          })
                        }
                      />
                      {t('settings.bearerKeyEnabled')}
                    </label>
                    <button
                      className="hub-icon-btn sm"
                      disabled={busy}
                      aria-label={t('common.delete')}
                      onClick={() => setRemovingKey(key)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              {!keys.some((key) => key.userGroupId === keyGroup.id) && (
                <button
                  className="hub-btn primary"
                  disabled={busy}
                  onClick={() => void createKey(keyGroup)}
                >
                  <KeyRound size={14} />
                  {t('userGroups.createKey')}
                </button>
              )}
            </div>
            <div className="hub-directory-dialog-footer">
              <button className="hub-btn" disabled={busy} onClick={() => setKeyGroup(undefined)}>
                {t('common.close')}
              </button>
            </div>
          </section>
        </div>
      )}
      {permissions && (
        <div
          className="hub-directory-overlay"
          onClick={() => {
            if (!busy) setPermissions(undefined);
          }}
        >
          <section
            className="hub-directory-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-permissions-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="hub-directory-dialog-header">
              <div>
                <h2 id="group-permissions-title" className="hub-card-title">
                  {t('userDirectory.permissionsFor', { name: permissions.name })}
                </h2>
                <p className="hub-config-note">{t('userDirectory.targetHint')}</p>
              </div>
              <button
                className="hub-icon-btn"
                aria-label={t('common.close')}
                disabled={busy}
                onClick={() => setPermissions(undefined)}
              >
                <X size={17} />
              </button>
            </div>
            {error && (
              <p role="alert" className="px-5 pt-3 text-sm text-[var(--hub-err)]">
                {error}
              </p>
            )}
            <div className="hub-directory-permission-tools">
              <select
                className="hub-input hub-directory-permission-catalog"
                aria-label={t('catalog.label')}
                value={resourceCatalog}
                disabled={busy}
                onChange={(event) => setResourceCatalog(event.target.value)}
              >
                <option value="*">{t('catalog.all')}</option>
                <option value="">{t('catalog.public')}</option>
                {resourceCatalogs.map((catalog) => (
                  <option key={catalog} value={catalog}>
                    {catalog}
                  </option>
                ))}
              </select>
              <div className="hub-directory-search">
                <Search size={14} />
                <input
                  aria-label={t('userDirectory.searchServers')}
                  placeholder={t('userDirectory.searchServers')}
                  value={resourceQuery}
                  onChange={(event) => setResourceQuery(event.target.value)}
                />
              </div>
              <button
                className="hub-btn sm"
                disabled={busy || !visibleResources.length}
                onClick={() => selectVisible(true)}
              >
                {t('userDirectory.selectVisible')}
              </button>
              <button
                className="hub-btn ghost sm"
                disabled={busy || !visibleResources.length}
                onClick={() => selectVisible(false)}
              >
                {t('userDirectory.clearVisible')}
              </button>
            </div>
            <div className="hub-directory-permission-list">
              {visibleResources.map((server) => {
                const targets = targetsFor(server);
                const resource = permissions.servers.find((entry) => entry.name === server.name);
                const complete = resourceComplete(server);
                return (
                  <div className="hub-directory-resource" key={server.name}>
                    <label className="hub-directory-resource-label">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={complete}
                        ref={(node) => {
                          if (node) node.indeterminate = !!resource && !complete;
                        }}
                        onChange={(event) =>
                          updateResource(
                            server,
                            targets.length ? targets.map((target) => target.path) : undefined,
                            event.target.checked,
                          )
                        }
                      />
                      <span>{server.name}</span>
                      <small>
                        {targets.length
                          ? t('userDirectory.targetCount', { count: targets.length })
                          : t('userDirectory.singleConnection')}
                      </small>
                    </label>
                    {targets.length > 0 && (
                      <div className="hub-directory-resource-targets">
                        {targets.map((target) => (
                          <label className="hub-checkbox-label" key={target.path}>
                            <input
                              type="checkbox"
                              disabled={busy}
                              checked={
                                !!resource &&
                                (resource.targets === undefined ||
                                  resource.targets.includes(target.path))
                              }
                              onChange={(event) => {
                                const current = resource
                                  ? (resource.targets ?? targets.map((entry) => entry.path))
                                  : [];
                                const next = event.target.checked
                                  ? [...new Set([...current, target.path])]
                                  : current.filter((path) => path !== target.path);
                                updateResource(server, next, next.length > 0);
                              }}
                            />
                            <span className="break-all">{target.path}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {!visibleResources.length && (
                <p className="hub-config-note p-4">
                  {t(servers.length ? 'userDirectory.noMatchingResources' : 'userGroups.noServers')}
                </p>
              )}
            </div>
            <div className="hub-directory-dialog-footer">
              <span className="hub-config-note">
                {t('userGroups.serverCount', { count: permissions.servers.length })}
              </span>
              <button className="hub-btn" disabled={busy} onClick={() => setPermissions(undefined)}>
                {t('common.cancel')}
              </button>
              <button
                className="hub-btn primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await saveGroup(permissions);
                    setPermissions(undefined);
                  })
                }
              >
                {t('common.save')}
              </button>
            </div>
          </section>
        </div>
      )}
      {editingGroup && (
        <div className="hub-directory-overlay">
          <form
            className="hub-directory-dialog compact"
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-edit-title"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const saved = await saveGroup(editingGroup);
                if (saved) expandGroup(saved.id);
                setEditingGroup(undefined);
              });
            }}
          >
            <div className="hub-directory-dialog-header">
              <h2 className="hub-card-title" id="group-edit-title">
                {t(editingGroup.id ? 'userDirectory.rename' : 'userDirectory.createGroup')}
              </h2>
              <button
                type="button"
                className="hub-icon-btn"
                disabled={busy}
                aria-label={t('common.close')}
                onClick={() => setEditingGroup(undefined)}
              >
                <X size={17} />
              </button>
            </div>
            {error && (
              <p role="alert" className="px-5 pt-3 text-sm text-[var(--hub-err)]">
                {error}
              </p>
            )}
            <div className="space-y-4 p-5">
              {auth.user.isAdmin && (
                <label className="hub-field">
                  <span className="hub-label">{t('userDirectory.owner')}</span>
                  <select
                    className="hub-input"
                    value={editingGroup.owner}
                    disabled={busy || !!editingGroup.id}
                    onChange={(event) =>
                      setEditingGroup({ ...editingGroup, owner: event.target.value, servers: [] })
                    }
                  >
                    {users.map((user) => (
                      <option value={user.username} key={user.username}>
                        {user.username}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="hub-field">
                <span className="hub-label">{t('userGroups.name')}</span>
                <input
                  autoFocus
                  required
                  maxLength={100}
                  className="hub-input"
                  value={editingGroup.name}
                  disabled={busy}
                  onChange={(event) =>
                    setEditingGroup({ ...editingGroup, name: event.target.value })
                  }
                />
              </label>
              <label className="hub-field">
                <span className="hub-label">{t('groups.description')}</span>
                <input
                  className="hub-input"
                  maxLength={1000}
                  value={editingGroup.description ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    setEditingGroup({ ...editingGroup, description: event.target.value })
                  }
                />
              </label>
              <label className="hub-checkbox-label">
                <input
                  type="checkbox"
                  checked={editingGroup.enabled}
                  disabled={busy}
                  onChange={(event) =>
                    setEditingGroup({ ...editingGroup, enabled: event.target.checked })
                  }
                />
                {t('userGroups.enabled')}
              </label>
            </div>
            <div className="hub-directory-dialog-footer">
              <button
                type="button"
                className="hub-btn"
                disabled={busy}
                onClick={() => setEditingGroup(undefined)}
              >
                {t('common.cancel')}
              </button>
              <button className="hub-btn primary" disabled={busy} type="submit">
                {t('common.save')}
              </button>
            </div>
          </form>
        </div>
      )}
      {newToken && (
        <div className="hub-directory-overlay">
          <section
            className="hub-directory-dialog compact"
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-key-title"
          >
            <div className="hub-directory-dialog-header">
              <h2 id="group-key-title" className="hub-card-title">
                {t('userGroups.tokenOnce')}
              </h2>
            </div>
            <div className="p-5 flex items-center gap-2">
              <SecretInput
                value={newToken}
                readOnly
                className="hub-input hub-mono"
                secretLabel={t('userGroups.groupKey')}
              />
              <button
                type="button"
                className="hub-btn shrink-0"
                onClick={async (event) => {
                  const button = event.currentTarget;
                  const copied = await copyText(newToken);
                  button.focus();
                  setTokenCopied(copied);
                  showToast(
                    t(copied ? 'common.copySuccess' : 'common.copyFailed'),
                    copied ? 'success' : 'error',
                  );
                }}
              >
                {tokenCopied ? <Check size={15} /> : <Copy size={15} />}
                {t(tokenCopied ? 'common.copied' : 'common.copy')}
              </button>
            </div>
            <div className="hub-directory-dialog-footer">
              <button className="hub-btn" onClick={() => setNewToken('')}>
                {t('common.close')}
              </button>
            </div>
          </section>
        </div>
      )}
      {addingUser && (
        <AddUserForm
          onAdd={() => {
            setAddingUser(false);
            void run(async () => undefined);
          }}
          onCancel={() => setAddingUser(false)}
        />
      )}
      {editingUser && (
        <EditUserForm
          user={editingUser}
          onEdit={() => {
            setEditingUser(undefined);
            void run(async () => undefined);
          }}
          onCancel={() => setEditingUser(undefined)}
        />
      )}
      <DeleteDialog
        serverName={removingKey?.name ?? ''}
        isOpen={!!removingKey}
        title={t('userDirectory.deleteKeyTitle')}
        message={t('userDirectory.deleteKeyHint')}
        onClose={() => setRemovingKey(undefined)}
        onConfirm={() =>
          void run(async () => {
            const result = await apiDelete(`/auth/keys/${removingKey!.id}`);
            if (!result.success) throw new Error(result.message || t('userGroups.failed'));
            setRemovingKey(undefined);
          })
        }
      />
      <DeleteDialog
        serverName={removingUser?.username ?? ''}
        isOpen={!!removingUser}
        isUser
        onClose={() => setRemovingUser(undefined)}
        onConfirm={() =>
          void run(async () => {
            const result = await apiDelete(`/users/${encodeURIComponent(removingUser!.username)}`);
            if (!result.success) throw new Error(result.message || t('users.deleteError'));
            setRemovingUser(undefined);
          })
        }
      />
      <DeleteDialog
        serverName={removingGroup?.name ?? ''}
        isOpen={!!removingGroup}
        title={t('userGroups.deleteTitle')}
        message={t('userGroups.deleteHint')}
        onClose={() => setRemovingGroup(undefined)}
        onConfirm={() =>
          void run(async () => {
            const result = await apiDelete(`/user-groups/${removingGroup!.id}`);
            if (!result.success) throw new Error(result.message || t('userGroups.failed'));
            setRemovingGroup(undefined);
          })
        }
      />
    </div>
  );
}
