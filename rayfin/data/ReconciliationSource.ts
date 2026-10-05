import { authenticated, entity, int, text, uuid } from '@microsoft/rayfin-core';

@entity()
@authenticated('*', { policy: (claims, item) => claims.sub.eq(item.user_id) })
export class ReconciliationSource {
  @uuid() id!: string;
  @text({ max: 64 }) workspaceId!: string;
  @text({ max: 255 }) workspaceName!: string;
  @text({ max: 64 }) itemId!: string;
  @text({ max: 255 }) itemName!: string;
  @text({ max: 20 }) itemType!: 'Lakehouse' | 'Warehouse';
  @text({ max: 512 }) sqlEndpoint!: string;
  @int() objectCount!: number;
  @text({ max: 4000 }) schemaJson!: string;
  @text({ max: 255 }) user_id!: string;
}