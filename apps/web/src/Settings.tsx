import { SystemManagement } from './SystemManagement';
import { IntegrationsPage } from './IntegrationsPage';

export { TeamsPage } from './TeamsPage';
export function AccountPage({ admin }: { admin: boolean }) {
  return admin ? <SystemManagement/> : <IntegrationsPage/>;
}
