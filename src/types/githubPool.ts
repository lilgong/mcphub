export interface GithubPoolAccount {
  id: string;
  login: string;
  token: string;
}
export interface GithubPoolSnapshot {
  revision: string;
  accounts: GithubPoolAccount[];
}
export interface GithubTaskLease {
  run: string;
  task: string;
  holder: string;
  account: GithubPoolAccount;
}
