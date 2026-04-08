export type PendingProjectCreate = {
  userId: string;
  rawName: string;
  guildId: string;
  categoryId: string;
  expiresAt: number;
};
