import { runPopupRelay } from '@azure/msal-browser/popup-relay';

runPopupRelay({ allowedAuthorityOrigins: ['https://login.microsoftonline.com'] });
