import { LightningElement, api, wire } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { getObjectInfo } from 'lightning/uiObjectInfoApi';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import { CloseActionScreenEvent } from 'lightning/actions';

import CASE_OBJECT from '@salesforce/schema/Case';
import ACCOUNT_NAME from '@salesforce/schema/Account.Name';

/**
 * Allowlist de cuentas que pueden ver tipos de registro restringidos.
 * Hoy solo "Kaufmann" tiene acceso a "Demandas". Cuando se sumen más clientes,
 * mover esto a un Custom Metadata Type (ej. `RecordType_Account_Mapping__mdt`)
 * para que el equipo de negocio lo administre sin redeploy.
 */
const ALLOWED_ACCOUNTS_FOR_RESTRICTED_RT = new Set(['Kaufmann']);
const RESTRICTED_RECORD_TYPE_NAMES = new Set(['Demandas']);

export default class NewTicketQuickAction extends NavigationMixin(LightningElement) {
    // recordId = AccountId (la Quick Action vive en el objeto Account)
    @api recordId;

    selectedRecordTypeId = '';
    recordTypeOptions = [];

    accountName;
    rawRecordTypeInfos;

    // === WIRES ===========================================================

    @wire(getRecord, { recordId: '$recordId', fields: [ACCOUNT_NAME] })
    wiredAccount({ data, error }) {
        if (data) {
            this.accountName = getFieldValue(data, ACCOUNT_NAME);
            this.computeRecordTypeOptions();
        } else if (error) {
            console.error('Error cargando Account:', error);
        }
    }

    @wire(getObjectInfo, { objectApiName: CASE_OBJECT })
    wiredCaseInfo({ data, error }) {
        if (data) {
            this.rawRecordTypeInfos = data.recordTypeInfos;
            this.computeRecordTypeOptions();
        } else if (error) {
            console.error('Error cargando metadata de Case:', error);
        }
    }

    // === CORE BUSINESS RULE =============================================
    // - Quita el RT "Master".
    // - Respeta `available` (CRUD/profile del usuario).
    // - Si la cuenta NO está en la allowlist, esconde los RT restringidos.
    computeRecordTypeOptions() {
        if (!this.rawRecordTypeInfos) {
            return;
        }
        const accountAllowsRestricted =
            ALLOWED_ACCOUNTS_FOR_RESTRICTED_RT.has(this.accountName);

        this.recordTypeOptions = Object.values(this.rawRecordTypeInfos)
            .filter((rt) => rt.available && !rt.master)
            .filter(
                (rt) =>
                    accountAllowsRestricted ||
                    !RESTRICTED_RECORD_TYPE_NAMES.has(rt.name)
            )
            .map((rt) => ({ label: rt.name, value: rt.recordTypeId }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    // === GETTERS =========================================================

    get isContinueDisabled() {
        return !this.selectedRecordTypeId;
    }

    get headerLabel() {
        return this.accountName
            ? `Nuevo Ticket para ${this.accountName}`
            : 'Nuevo Ticket';
    }

    // === HANDLERS ========================================================

    handleRecordTypeChange(event) {
        this.selectedRecordTypeId = event.detail.value;
    }

    handleClose() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }

    // Navega a la página estándar de "Nuevo Case" pasando el RT elegido
    // y precargando AccountId. Así reutilizamos el layout completo de SF
    // (campos custom, validaciones, related lookups) en vez de replicarlo.
    handleContinue() {
        if (!this.selectedRecordTypeId) {
            return;
        }

        this[NavigationMixin.Navigate]({
            type: 'standard__objectPage',
            attributes: {
                objectApiName: 'Case',
                actionName: 'new'
            },
            state: {
                recordTypeId: this.selectedRecordTypeId,
                defaultFieldValues: `AccountId=${this.recordId}`,
                // navigationLocation = al guardar, vuelve a la cuenta
                nooverride: '1'
            }
        });

        // Cerramos el modal de la Quick Action; la navegación ya disparó.
        this.handleClose();
    }
}
