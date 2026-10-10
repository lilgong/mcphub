import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Folder,
  FolderOpen,
  Users,
  UserRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Pencil,
  Trash2,
  KeyRound,
  Search,
  GripVertical,
  X,
  ChevronRight,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { apiGet, apiPost, apiPut, apiDelete, type ApiResponse } from '../utils/fetchInterceptor';
import type { Server, User, BearerKey } from '../types';
import type { UserGroup, UserGroupResource } from '../../../src/types/userGroup';
import AddUserForm from '../components/AddUserForm';
import EditUserForm from '../components/EditUserForm';
import SecretInput from '../components/SecretInput';
import DeleteDialog from '../components/ui/DeleteDialog';

const DRAG_TYPE = 'application/x-mcphub-user';

export default function UsersPage() {
  const { t } = useTranslation();
  const { auth } = useAuth();
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [keys, setKeys] = useState<BearerKey[]>([]);
  const [selected, setSelected] = useState('all');
  const [dropTarget, setDropTarget] = useState<string>();
  const [query, setQuery] = useState('');
  const [resourceQuery, setResourceQuery] = useState('');
  const [permissions, setPermissions] = useState<UserGroup>();
  const [editingGroup, setEditingGroup] = useState<UserGroup>();
  const [removingGroup, setRemovingGroup] = useState<UserGroup>();
  const [addingUser, setAddingUser] = useState(false);
  const [editingUser, setEditingUser] = useState<User>();
  const [removingUser, setRemovingUser] = useState<User>();
  const [newToken, setNewToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const dialogOpen = !!permissions || !!editingGroup || !!newToken;
  useEffect(() => {
    if (!dialogOpen) return;
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
      }
      if (event.key === 'Tab') {
        const items = focusable();
        const first = items[0];
        const last = items.at(-1);
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
  }, [dialogOpen]);
  const load = useCallback(async () => {
    const replies = await Promise.all([
      apiGet<ApiResponse<UserGroup[]>>('/user-groups'),
      apiGet<ApiResponse<Server[]>>('/servers'),
      apiGet<ApiResponse<User[]>>('/users'),
      apiGet<ApiResponse<BearerKey[]>>('/auth/keys'),
    ]);
    if (replies.some((reply) => !reply.success || !reply.data))
      throw new Error(t('userGroups.failed'));
    setGroups(replies[0].data!);
    setServers(replies[1].data!.sort((a, b) => a.name.localeCompare(b.name)));
    setUsers(replies[2].data!.sort((a, b) => a.username.localeCompare(b.username)));
    setKeys(replies[3].data!);
  }, [t]);
  useEffect(() => {
    if (auth.user?.isAdmin)
      void load()
        .catch(() => setError(t('userGroups.failed')))
        .finally(() => setLoading(false));
  }, [auth.user?.isAdmin, load, t]);
  useEffect(() => {
    if (
      selected !== 'all' &&
      selected !== 'ungrouped' &&
      !groups.some((group) => group.id === selected)
    )
      setSelected('all');
  }, [groups, selected]);
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
  const moveUser = (username: string, groupId: string | null) =>
    run(async () => {
      const result = await apiPut('/user-groups/membership', { username, groupId });
      if (!result.success) throw new Error(result.message || t('userGroups.failed'));
    });
  const drop = (event: DragEvent, groupId: string | null) => {
    event.preventDefault();
    setDropTarget(undefined);
    const username = event.dataTransfer.getData(DRAG_TYPE);
    if (!busy && users.some((user) => user.username === username)) void moveUser(username, groupId);
  };
  const dropProps = (id: string, groupId: string | null) => ({
    onDragOver: (event: DragEvent) => {
      if (!busy && event.dataTransfer.types.includes(DRAG_TYPE)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropTarget(id);
      }
    },
    onDragLeave: () => setDropTarget(undefined),
    onDrop: (event: DragEvent) => drop(event, groupId),
  });
  const createKey = (group?: UserGroup) =>
    run(async () => {
      const result = await apiPost<ApiResponse<BearerKey>>('/auth/keys', {
        name: group ? `${group.name} · ${t('userGroups.groupKey')}` : t('userGroups.sharedKey'),
        kind: 'system',
        enabled: true,
        accessType: 'all',
        userGroupId: group?.id,
      });
      if (!result.success || !result.data)
        throw new Error(result.message || t('userGroups.failed'));
      setNewToken(result.data.token);
    });
  const membership = (username: string) =>
    groups.filter((group) => group.members.includes(username));
  const activeGroup = groups.find((group) => group.id === selected);
  const visibleUsers = users.filter(
    (user) =>
      (selected === 'all' ||
        (selected === 'ungrouped'
          ? membership(user.username).length === 0
          : activeGroup?.members.includes(user.username))) &&
      `${user.username} ${user.email ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  );
  const folderClass = (id: string) =>
    `hub-directory-folder ${selected === id ? 'selected' : ''} ${dropTarget === id ? 'drop-target' : ''}`;
  const targetsFor = (server: Server) => server.runtime?.targets ?? [];
  const openPermissions = (group: UserGroup) => {
    setError('');
    setPermissions({
      ...structuredClone(group),
      servers: group.servers.flatMap((resource) => {
        const server = servers.find((entry) => entry.name === resource.name);
        if (!server) return [];
        const targets = targetsFor(server);
        return [
          {
            ...resource,
            ...(resource.targets === undefined && targets.length
              ? { targets: targets.map((target) => target.path) }
              : {}),
          },
        ];
      }),
    });
  };
  const allResources = (): UserGroupResource[] =>
    servers.map((server) => ({
      name: server.name,
      ...(targetsFor(server).length
        ? { targets: targetsFor(server).map((target) => target.path) }
        : {}),
    }));
  const resourceComplete = (server: Server) => {
    const resource = permissions?.servers.find((entry) => entry.name === server.name);
    return (
      !!resource &&
      (resource.targets === undefined ||
        targetsFor(server).every((target) => resource.targets?.includes(target.path)))
    );
  };
  const updateResource = (server: Server, targets: string[] | undefined, checked: boolean) => {
    if (!permissions) return;
    setPermissions({
      ...permissions,
      servers: [
        ...permissions.servers.filter((entry) => entry.name !== server.name),
        ...(checked ? [{ name: server.name, ...(targets === undefined ? {} : { targets }) }] : []),
      ],
    });
  };
  if (!auth.user?.isAdmin) return <p>{t('users.adminRequired')}</p>;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="hub-h1">{t('userGroups.title')}</h1>
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
          <button
            className="hub-btn"
            disabled={busy}
            onClick={() =>
              setEditingGroup({ id: '', name: '', enabled: true, members: [], servers: [] })
            }
          >
            <Folder size={14} />
            {t('userDirectory.createGroup')}
          </button>
          <button className="hub-btn primary" disabled={busy} onClick={() => setAddingUser(true)}>
            <Plus size={14} />
            {t('users.add')}
          </button>
        </div>
      </div>
      {error && !dialogOpen && (
        <p role="alert" className="text-sm text-[var(--hub-err)]">
          {error}
        </p>
      )}
      <section className="hub-card hub-user-directory" aria-busy={busy}>
        <aside className="hub-directory-tree" aria-label={t('userDirectory.groupList')}>
          <div className="hub-directory-caption">{t('userDirectory.groupList')}</div>
          <button className={folderClass('all')} onClick={() => setSelected('all')}>
            <Users size={16} />
            <span>{t('userDirectory.allUsers')}</span>
            <small>{users.length}</small>
          </button>
          <button
            className={folderClass('ungrouped')}
            onClick={() => setSelected('ungrouped')}
            {...dropProps('ungrouped', null)}
          >
            <UserRound size={16} />
            <span>{t('userDirectory.ungrouped')}</span>
            <small>{users.filter((user) => !membership(user.username).length).length}</small>
          </button>
          <div className="hub-directory-divider" />
          {groups.map((group) => (
            <div
              key={group.id}
              className={folderClass(group.id)}
              {...dropProps(group.id, group.id)}
            >
              <button className="hub-directory-folder-name" onClick={() => setSelected(group.id)}>
                {selected === group.id ? <FolderOpen size={16} /> : <Folder size={16} />}
                <span title={group.name}>{group.name}</span>
                <small>{group.members.length}</small>
                {!group.enabled && <span className="hub-dot muted" />}
              </button>
              <button
                className="hub-icon-btn sm"
                aria-label={t('userDirectory.permissionsFor', { name: group.name })}
                title={t('userDirectory.permissions')}
                disabled={busy}
                onClick={() => {
                  setResourceQuery('');
                  openPermissions(group);
                }}
              >
                <ShieldCheck size={14} />
              </button>
            </div>
          ))}
          {!groups.length && <p className="hub-config-note px-2 py-3">{t('userGroups.empty')}</p>}
          <p className="hub-config-note hub-directory-hint">{t('userDirectory.dragHint')}</p>
        </aside>
        <div className="hub-directory-main">
          <div className="hub-directory-toolbar">
            <div className="flex items-center gap-2 min-w-0">
              <Users size={15} />
              <ChevronRight size={13} />
              <strong className="truncate">
                {activeGroup?.name ??
                  t(
                    selected === 'ungrouped' ? 'userDirectory.ungrouped' : 'userDirectory.allUsers',
                  )}
              </strong>
            </div>
            {activeGroup && (
              <div className="flex gap-1 flex-shrink-0">
                <button
                  className="hub-btn sm"
                  disabled={busy}
                  onClick={() => {
                    setResourceQuery('');
                    openPermissions(activeGroup);
                  }}
                >
                  <ShieldCheck size={13} />
                  {t('userDirectory.permissions')}
                </button>
                <button
                  className="hub-icon-btn sm"
                  title={t('userDirectory.rename')}
                  aria-label={t('userDirectory.rename')}
                  disabled={busy}
                  onClick={() => setEditingGroup(structuredClone(activeGroup))}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="hub-icon-btn sm"
                  title={t('common.delete')}
                  aria-label={t('userDirectory.deleteGroup')}
                  disabled={busy}
                  onClick={() => setRemovingGroup(activeGroup)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </div>
          <div className="hub-directory-search">
            <Search size={14} />
            <input
              aria-label={t('userDirectory.searchUsers')}
              placeholder={t('userDirectory.searchUsers')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {activeGroup && (
            <div className="hub-directory-summary">
              <span>{t('userGroups.serverCount', { count: activeGroup.servers.length })}</span>
              <span>{activeGroup.enabled ? t('common.active') : t('common.inactive')}</span>
              {keys.some((key) => key.userGroupId === activeGroup.id) ? (
                <span className="flex items-center gap-2">
                  <KeyRound size={13} />
                  {t('userDirectory.keyCreated')}
                </span>
              ) : (
                <button
                  className="hub-btn ghost sm"
                  disabled={busy}
                  onClick={() => void createKey(activeGroup)}
                >
                  <KeyRound size={13} />
                  {t('userGroups.createKey')}
                </button>
              )}
            </div>
          )}
          <div className="hub-directory-table-wrap">
            <table className="hub-directory-table">
              <thead>
                <tr>
                  <th>{t('users.username')}</th>
                  <th>{t('userDirectory.membership')}</th>
                  <th>{t('users.role')}</th>
                  <th>
                    <span className="sr-only">{t('users.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleUsers.map((user) => (
                  <tr
                    key={user.username}
                    draggable={!busy}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DRAG_TYPE, user.username);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                  >
                    <td>
                      <div className="flex items-center gap-2 min-w-0">
                        <GripVertical size={13} className="hub-directory-grip" />
                        <UserRound size={15} />
                        <div className="min-w-0">
                          <span className="hub-directory-username">{user.username}</span>
                          {user.email && <span className="hub-directory-email">{user.email}</span>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <select
                        className="hub-directory-membership"
                        aria-label={t('userDirectory.moveUser', { name: user.username })}
                        disabled={busy}
                        value={
                          membership(user.username).length === 1
                            ? membership(user.username)[0].id
                            : membership(user.username).length > 1
                              ? 'multiple'
                              : ''
                        }
                        onChange={(event) =>
                          void moveUser(user.username, event.target.value || null)
                        }
                      >
                        {membership(user.username).length > 1 && (
                          <option value="multiple" disabled>
                            {membership(user.username)
                              .map((group) => group.name)
                              .join(', ')}
                          </option>
                        )}
                        <option value="">{t('userDirectory.ungrouped')}</option>
                        {groups.map((group) => (
                          <option key={group.id} value={group.id}>
                            {group.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <span className="hub-tag">
                        {user.isAdmin ? t('users.admin') : t('users.user')}
                      </span>
                    </td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <button
                          className="hub-icon-btn sm"
                          aria-label={t('userDirectory.editUser', { name: user.username })}
                          title={t('users.edit')}
                          disabled={busy}
                          onClick={() => setEditingUser(user)}
                        >
                          <Pencil size={13} />
                        </button>
                        {user.username !== auth.user?.username && (
                          <button
                            className="hub-icon-btn sm"
                            aria-label={t('userDirectory.deleteUser', { name: user.username })}
                            title={t('users.delete')}
                            disabled={busy}
                            onClick={() => setRemovingUser(user)}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!visibleUsers.length && (
            <p className="hub-directory-empty">
              {t(loading ? 'app.loading' : 'userDirectory.noUsers')}
            </p>
          )}
          <div className="hub-directory-footer">
            {t('userGroups.memberCount', { count: visibleUsers.length })}
            {activeGroup && <span>{t('userDirectory.membersHint')}</span>}
          </div>
        </div>
      </section>
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
                disabled={busy}
                onClick={() => setPermissions({ ...permissions, servers: allResources() })}
              >
                {t('userDirectory.selectAll')}
              </button>
              <button
                className="hub-btn ghost sm"
                disabled={busy}
                onClick={() => setPermissions({ ...permissions, servers: [] })}
              >
                {t('userDirectory.clearAll')}
              </button>
            </div>
            <div className="hub-directory-permission-list">
              {servers
                .filter((server) => server.name.toLowerCase().includes(resourceQuery.toLowerCase()))
                .map((server) => {
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
              {!servers.length && (
                <p className="hub-config-note p-4">{t('userGroups.noServers')}</p>
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
                if (saved) setSelected(saved.id);
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
            <div className="p-5">
              <SecretInput
                value={newToken}
                readOnly
                className="hub-input hub-mono"
                secretLabel={t('userGroups.groupKey')}
              />
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
