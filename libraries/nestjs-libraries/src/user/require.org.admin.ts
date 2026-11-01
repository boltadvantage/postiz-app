// Bolt Advantage: org-wide controls (pause all posting, client costs,
// which channel types show) are for the organization's admins, not every
// member. req.org.users[0] is the signed-in user's membership (see
// AuthMiddleware), the same thing upstream uses to decide who sees the API key.
import { HttpException } from '@nestjs/common';

export const isOrgAdmin = (org: any) => ['ADMIN', 'SUPERADMIN'].includes(org?.users?.[0]?.role);

export function requireOrgAdmin(org: any) {
  if (!isOrgAdmin(org)) throw new HttpException('Only an admin of this workspace can do that', 403);
}
