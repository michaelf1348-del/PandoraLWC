import { LightningElement, api } from 'lwc';

/**
 * Capa fina para Quick Action: fuerza quick-action-mode en el hijo sin depender
 * del puente Aura ? propiedad booleana (que en algunos orgs no llega al LWC).
 */
export default class ImputacionesAMSQuickShell extends LightningElement {
    @api recordId;
}