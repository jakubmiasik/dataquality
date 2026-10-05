import { authenticated, date, entity, text, uuid } from '@microsoft/rayfin-core';

/**
 * Workspace-wide configuration entered from the in-app Configuration tab.
 *
 * These values used to be build-time Vite variables, which meant a redeploy was
 * the only way to correct them. Storing them here lets an operator fix the
 * Entra registration or gateway origin from the running app, and every user in
 * the workspace picks the change up on their next load.
 */
@entity()
@authenticated('*')
export class AppSetting {
  @uuid() id!: string;
  @text({ max: 64 }) settingKey!: string;
  @text({ max: 1000 }) settingValue!: string;
  @date() updatedAt!: Date;
  @text({ max: 255 }) updatedBy!: string;
  @text({ max: 255 }) user_id!: string;
}
