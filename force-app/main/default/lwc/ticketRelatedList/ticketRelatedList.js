import { LightningElement, api, wire, track } from 'lwc';
import { getObjectInfo } from 'lightning/uiObjectInfoApi';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import { refreshApex } from '@salesforce/apex';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { NavigationMixin } from 'lightning/navigation';

import CASE_OBJECT from '@salesforce/schema/Case';
import ACCOUNT_NAME from '@salesforce/schema/Account.Name';

import getTicketsByAccount from '@salesforce/apex/TicketController.getTicketsByAccount';

/**
 * Allowlist de cuentas que pueden ver tipos de registro restringidos.
 * Hoy solo "Kaufmann" tiene acceso a "Demanda". Cuando se sumen más clientes,
 * mover esto a un Custom Metadata Type (ej. `RecordType_Account_Mapping__mdt`)
 * para que el equipo de negocio lo administre sin redeploy.
 */
const ALLOWED_ACCOUNTS_FOR_RESTRICTED_RT = new Set(['Kaufmann']);
const RESTRICTED_RECORD_TYPE_NAMES = new Set(['Demandas']);

const COLUMNS = [
    {
        label: 'Número de caso',
        fieldName: 'CaseUrl',
        type: 'url',
        typeAttributes: { label: { fieldName: 'CaseNumber' }, target: '_self' },
        initialWidth: 130
    },
    { label: 'Estado', fieldName: 'Status', initialWidth: 180 },
    { label: 'Tipo de registro', fieldName: 'RecordTypeName', initialWidth: 180 },
    {
        label: 'Fecha en que se abrió',
        fieldName: 'CreatedDate',
        type: 'date',
        typeAttributes: {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        },
        initialWidth: 180
    },
    { label: 'Asunto', fieldName: 'Subject', wrapText: true }
];

export default class TicketRelatedList extends NavigationMixin(LightningElement) {
    @api recordId; // AccountId inyectado por la Lightning Record Page

    columns = COLUMNS;
    @track tickets = [];
    wiredTicketsResult;

    isModalOpen = false;
    isSaving = false;
    selectedRecordTypeId = '';
    recordTypeOptions = [];

    accountName;
    rawRecordTypeInfos;

    // === WIRES ===========================================================

    @wire(getRecord, { recordId: '$recordId', fields: [ACCOUNT_NAME] })
    wiredAccount({ data, error }) {
        if (data) {
            this.accountName = getFieldValue(data, ACCOUNT_NAME);
            // Recalcular opciones cuando ya conocemos el nombre de la cuenta.
            this.computeRecordTypeOptions();
        } else if (error) {
            console.error('Error cargando Account:', error);
        }
    }

    @wire(getObjectInfo, { objectApiName: CASE_OBJECT })
    wiredCaseInfo({ data, error }) {
        if (data) {
            this.rawRecordTypeInfos = data.recordTypeInfos;
            // Puede llegar antes que accountName: recomputamos cuando ambos estén listos.
            this.computeRecordTypeOptions();
        } else if (error) {
            console.error('Error cargando metadata de Case:', error);
        }
    }

    @wire(getTicketsByAccount, { accountId: '$recordId' })
    wiredTickets(result) {
        this.wiredTicketsResult = result;
        if (result.data) {
            this.tickets = result.data;
        } else if (result.error) {
            console.error('Error cargando tickets:', result.error);
        }
    }

    // === CORE BUSINESS RULE =============================================
    // Filtro de Record Types en cliente.
    // - Quitamos el RT "Master" (siempre presente).
    // - Filtramos los RT no disponibles para el perfil del usuario.
    // - Si la cuenta NO está en la allowlist, escondemos los RT restringidos
    //   (hoy: "Demanda"). Cualquier otra cuenta verá el resto de tipos.
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

    // === GETTERS PARA TEMPLATE ==========================================

    get ticketCount() {
        return this.tickets ? this.tickets.length : 0;
    }

    get hasTickets() {
        return this.tickets && this.tickets.length > 0;
    }

    get isFormVisible() {
        return Boolean(this.selectedRecordTypeId);
    }

    get modalTitle() {
        return this.accountName
            ? `Nuevo Ticket para ${this.accountName}`
            : 'Nuevo Ticket';
    }

    // === HANDLERS ========================================================

    handleNewClick() {
        this.selectedRecordTypeId = '';
        this.isModalOpen = true;
    }

    handleCloseModal() {
        this.isModalOpen = false;
        this.selectedRecordTypeId = '';
    }

    handleRecordTypeChange(event) {
        this.selectedRecordTypeId = event.detail.value;
    }

    handleSubmit(event) {
        // Interceptamos el submit para forzar AccountId y RecordTypeId,
        // garantizando la relación con la cuenta padre incluso si alguien
        // remueve los inputs del template en el futuro.
        event.preventDefault();
        this.isSaving = true;

        const fields = { ...event.detail.fields };
        fields.AccountId = this.recordId;
        fields.RecordTypeId = this.selectedRecordTypeId;

        this.template
            .querySelector('lightning-record-edit-form')
            .submit(fields);
    }

    handleSuccess(event) {
        this.isSaving = false;
        this.dispatchEvent(
            new ShowToastEvent({
                title: 'Ticket creado',
                message: `Caso creado correctamente (Id: ${event.detail.id})`,
                variant: 'success'
            })
        );
        this.handleCloseModal();
        // Refrescamos el wire sin recargar la página para mantener UX rápida.
        return refreshApex(this.wiredTicketsResult);
    }

    handleError(event) {
        this.isSaving = false;
        this.dispatchEvent(
            new ShowToastEvent({
                title: 'Error al crear ticket',
                message: event.detail.message || 'Revisa los campos requeridos.',
                variant: 'error'
            })
        );
    }

    handleViewAll(event) {
        event.preventDefault();
        // Navegamos a la related list estándar como fallback "Ver todos".
        this[NavigationMixin.Navigate]({
            type: 'standard__recordRelationshipPage',
            attributes: {
                recordId: this.recordId,
                objectApiName: 'Account',
                relationshipApiName: 'Cases',
                actionName: 'view'
            }
        });
    }
}
