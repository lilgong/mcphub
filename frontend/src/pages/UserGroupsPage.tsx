import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, RefreshCw, Edit3, Trash2, KeyRound } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { apiGet, apiPost, apiPut, apiDelete, type ApiResponse } from '../utils/fetchInterceptor';
import type { Server, User, BearerKey } from '../types';
import type { UserGroup } from '../../../src/types/userGroup';
import SecretInput from '../components/SecretInput';
import DeleteDialog from '../components/ui/DeleteDialog';

export default function UserGroupsPage() {
  const { t } = useTranslation();
  const { auth } = useAuth();
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [keys, setKeys] = useState<BearerKey[]>([]);
  const [draft, setDraft] = useState<UserGroup>();
  const [removing, setRemoving] = useState<UserGroup>();
  const [newToken, setNewToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const replies = await Promise.all([
        apiGet<ApiResponse<UserGroup[]>>('/user-groups'),
        apiGet<ApiResponse<Server[]>>('/servers'),
        apiGet<ApiResponse<User[]>>('/users'),
        apiGet<ApiResponse<BearerKey[]>>('/auth/keys'),
      ]);
      if (replies.some((reply) => !reply.success || !reply.data))
        throw new Error(t('userGroups.failed'));
      setGroups(replies[0].data!);
      setServers(replies[1].data!);
      setUsers(replies[2].data!);
      setKeys(replies[3].data!);
    } catch {
      setError(t('userGroups.failed'));
    }
  }, [t]);
  useEffect(() => {
    if (auth.user?.isAdmin) void load();
  }, [auth.user?.isAdmin, load]);
  if (!auth.user?.isAdmin) return <p>{t('users.adminRequired')}</p>;
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
  const save = () =>
    run(async () => {
      if (!draft) return;
      const { id, ...body } = draft;
      const result = id
        ? await apiPut(`/user-groups/${id}`, body)
        : await apiPost('/user-groups', body);
      if (!result.success) throw new Error(result.message || t('userGroups.failed'));
      setDraft(undefined);
    });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="hub-h1">{t('userGroups.title')}</h1>
          <p className="hub-sub">{t('userGroups.description')}</p>
        </div>
        <div className="flex gap-2">
          <button className="hub-btn" disabled={busy} onClick={() => void load()}>
            <RefreshCw size={14} />
            {t('common.refresh')}
          </button>
          <button
            className="hub-btn primary"
            disabled={busy}
            onClick={() => setDraft({ id: '', name: '', enabled: true, members: [], servers: [] })}
          >
            <Plus size={14} />
            {t('userGroups.add')}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-[var(--hub-err)]">
          {error}
        </p>
      )}
      <section className="hub-card flex flex-wrap items-center justify-between gap-4 p-4">
        <div>
          <h2 className="hub-card-title">{t('userGroups.sharedKey')}</h2>
          <p className="hub-sub">{t('userGroups.sharedHint')}</p>
        </div>
        <button className="hub-btn" disabled={busy} onClick={() => void createKey()}>
          <KeyRound size={14} />
          {t('userGroups.createSharedKey')}
        </button>
      </section>
      {newToken && (
        <section className="hub-card space-y-3 p-4">
          <h2 className="hub-card-title">{t('userGroups.tokenOnce')}</h2>
          <SecretInput
            value={newToken}
            readOnly
            className="hub-input hub-mono"
            secretLabel={t('userGroups.groupKey')}
          />
          <button className="hub-btn" onClick={() => setNewToken('')}>
            {t('common.close')}
          </button>
        </section>
      )}
      {draft ? (
        <form
          className="hub-card max-w-3xl space-y-5 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="hub-field">
              <span className="hub-label">{t('userGroups.name')}</span>
              <input
                required
                maxLength={100}
                className="hub-input"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="hub-field">
              <span className="hub-label">{t('groups.description')}</span>
              <input
                maxLength={1000}
                className="hub-input"
                value={draft.description ?? ''}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
          </div>
          <label className="hub-checkbox-label">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            {t('userGroups.enabled')}
          </label>
          <section className="space-y-3">
            <h2 className="hub-card-title">{t('userGroups.members')}</h2>
            <p className="hub-config-note">{t('userGroups.membersHint')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {users.map((user) => (
                <label key={user.username} className="hub-checkbox-label">
                  <input
                    type="checkbox"
                    checked={draft.members.includes(user.username)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        members: e.target.checked
                          ? [...draft.members, user.username]
                          : draft.members.filter((name) => name !== user.username),
                      })
                    }
                  />
                  {user.username}
                </label>
              ))}
            </div>
          </section>
          <section className="space-y-3">
            <h2 className="hub-card-title">{t('userGroups.resources')}</h2>
            <p className="hub-config-note">{t('userGroups.resourcesHint')}</p>
            {servers.map((server) => {
              const resource = draft.servers.find((entry) => entry.name === server.name);
              const targets = server.runtime?.targets ?? [];
              const changeTargets = (paths: string[] | undefined) =>
                setDraft({
                  ...draft,
                  servers: draft.servers.map((entry) =>
                    entry.name === server.name
                      ? { name: entry.name, ...(paths !== undefined ? { targets: paths } : {}) }
                      : entry,
                  ),
                });
              return (
                <div
                  key={server.name}
                  className="rounded-lg border border-[var(--hub-line)] p-3 space-y-3"
                >
                  <label className="hub-checkbox-label">
                    <input
                      type="checkbox"
                      checked={!!resource}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          servers: e.target.checked
                            ? [...draft.servers, { name: server.name }]
                            : draft.servers.filter((entry) => entry.name !== server.name),
                        })
                      }
                    />
                    <span className="hub-mono">{server.name}</span>
                    <span className="hub-sub !m-0">
                      {server.enabled === false ? t('common.inactive') : ''}
                    </span>
                  </label>
                  {resource && !!targets.length && (
                    <div className="space-y-2 border-t border-[var(--hub-line-2)] pt-3">
                      <label className="hub-checkbox-label">
                        <input
                          type="checkbox"
                          checked={resource.targets !== undefined}
                          onChange={(e) => changeTargets(e.target.checked ? [] : undefined)}
                        />
                        {t('userGroups.restrictTargets')}
                      </label>
                      {resource.targets !== undefined ? (
                        <div className="grid gap-2 sm:grid-cols-2">
                          {targets.map((target) => (
                            <label className="hub-checkbox-label" key={target.path}>
                              <input
                                type="checkbox"
                                checked={resource.targets?.includes(target.path) ?? false}
                                onChange={(e) =>
                                  changeTargets(
                                    e.target.checked
                                      ? [...(resource.targets ?? []), target.path]
                                      : resource.targets?.filter((path) => path !== target.path),
                                  )
                                }
                              />
                              <span className="hub-mono">{target.path}</span>
                            </label>
                          ))}
                        </div>
                      ) : (
                        <p className="hub-config-note">{t('userGroups.allTargetsHint')}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {!servers.length && <p className="hub-config-note">{t('userGroups.noServers')}</p>}
          </section>
          <div className="flex gap-2">
            <button type="submit" className="hub-btn primary" disabled={busy}>
              {t('common.save')}
            </button>
            <button
              type="button"
              className="hub-btn"
              disabled={busy}
              onClick={() => setDraft(undefined)}
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map((group) => {
            const key = keys.find((entry) => entry.userGroupId === group.id);
            return (
              <section className="hub-card space-y-3 p-4" key={group.id}>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="hub-card-title">{group.name}</h2>
                  <span className={`hub-status ${group.enabled ? 'ok' : 'muted'}`}>
                    <span className="hub-dot" />
                    {group.enabled ? t('common.active') : t('common.inactive')}
                  </span>
                </div>
                {group.description && <p className="hub-config-note">{group.description}</p>}
                <p className="hub-config-note">
                  {t('userGroups.memberCount', { count: group.members.length })} ·{' '}
                  {t('userGroups.serverCount', { count: group.servers.length })}
                </p>
                <div className="space-y-1">
                  {group.servers.map((resource) => (
                    <div className="text-[13px]" key={resource.name}>
                      <span className="hub-mono">{resource.name}</span>
                      <span className="text-[var(--hub-ink-3)]">
                        {' '}
                        ·{' '}
                        {resource.targets === undefined
                          ? t('userGroups.allTargets')
                          : resource.targets.join(', ') || t('userGroups.noTargets')}
                      </span>
                    </div>
                  ))}
                </div>
                {key && (
                  <p className="hub-config-note hub-mono">
                    {t('userGroups.groupKey')}: {key.token} ·{' '}
                    {key.enabled ? t('common.active') : t('common.inactive')}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    className="hub-btn"
                    disabled={busy}
                    onClick={() => setDraft(structuredClone(group))}
                  >
                    <Edit3 size={14} />
                    {t('server.edit')}
                  </button>
                  {!key && (
                    <button
                      className="hub-btn"
                      disabled={busy}
                      onClick={() => void createKey(group)}
                    >
                      <KeyRound size={14} />
                      {t('userGroups.createKey')}
                    </button>
                  )}
                  <button
                    className="hub-btn danger"
                    disabled={busy}
                    onClick={() => setRemoving(group)}
                  >
                    <Trash2 size={14} />
                    {t('common.delete')}
                  </button>
                </div>
              </section>
            );
          })}
          {!groups.length && <p className="hub-config-note">{t('userGroups.empty')}</p>}
        </div>
      )}
      <DeleteDialog
        serverName={removing?.name ?? ''}
        isOpen={!!removing}
        title={t('userGroups.deleteTitle')}
        message={t('userGroups.deleteHint')}
        onClose={() => setRemoving(undefined)}
        onConfirm={() => {
          if (removing)
            void run(async () => {
              const result = await apiDelete(`/user-groups/${removing.id}`);
              if (!result.success) throw new Error(t('userGroups.failed'));
              setRemoving(undefined);
            });
        }}
      />
    </div>
  );
}
