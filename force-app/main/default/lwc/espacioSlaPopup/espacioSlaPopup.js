import { LightningElement, api, wire } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { getRecord, getFieldValue, getRecordNotifyChange } from 'lightning/uiRecordApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { refreshApex } from '@salesforce/apex';
import CASE_STATUS from '@salesforce/schema/Case.Status';
import CASE_IS_CLOSED from '@salesforce/schema/Case.IsClosed';
import getPlantillasForCase from '@salesforce/apex/EquipoResolutoresController.getPlantillasForCase';
import addPublicCaseComment from '@salesforce/apex/EquipoResolutoresController.addPublicCaseComment';
import USER_ID from '@salesforce/user/Id';
import { createEquipoRealtimeSubscription } from 'c/equipoResolutoresRealtime';

export default class EspacioSlaPopup extends NavigationMixin(LightningElement) {
    @api caseId;
    @api caseNumber;
    @api estadoFields = 'SubEstado__c,Status';

    plantillas = [];
    plantillasOptions = [];
    selectedPlantillaName = '';
    commentText = '';
    saving = false;

    _caseIsClosedFlag = false;
    _wiredCaseStatus;

    wiredPlantillas;
    _realtimeSubscription;

    @wire(getRecord, {
        recordId: '$caseId',
        fields: [CASE_STATUS, CASE_IS_CLOSED]
    })
    wiredCase({ data }) {
        if (!data) {
            return;
        }
        this._caseIsClosedFlag = getFieldValue(data, CASE_IS_CLOSED) === true;
        this._wiredCaseStatus = getFieldValue(data, CASE_STATUS);
    }

    @wire(getPlantillasForCase, { caseId: '$caseId' })
    wiredFn(result) {
        this.wiredPlantillas = result;
        if (result.data) {
            this.plantillas = result.data;
            this.plantillasOptions = result.data.map((p) => ({
                label: p.categoria ? `${p.label} (${p.categoria})` : p.label,
                value: p.name
            }));
        }
    }

    get isCaseClosed() {
        return this._caseIsClosedFlag || this.isClosureStatus(this._wiredCaseStatus);
    }

    isClosureStatus(status) {
        if (!status) {
            return false;
        }
        const s = String(status).trim();
        const lower = s.toLowerCase();
        return s === 'Cierre' || s === 'Cerrado' || s === 'Closed'
            || s === 'Cancelado' || s === 'Cancelled'
            || lower.includes('cerrad') || lower.includes('closed')
            || lower.includes('cancel');
    }

    get isReadOnly() {
        return this.isCaseClosed;
    }

    get closedBannerMessage() {
        return 'Este ticket está cerrado. Solo podés consultar el ticket completo; no se puede cambiar estado ni enviar comentarios.';
    }

    get estadoFieldList() {
        return (this.estadoFields || '')
            .split(',')
            .map((f) => f.trim())
            .filter(Boolean);
    }

    connectedCallback() {
        this._realtimeSubscription = createEquipoRealtimeSubscription({
            userId: USER_ID,
            shouldHandle: ({ caseId }) =>
                Boolean(caseId && this.caseId && caseId === this.caseId),
            onNotify: () => this.handleRealtimeRefresh()
        });
    }

    disconnectedCallback() {
        if (this._realtimeSubscription) {
            this._realtimeSubscription.disconnect();
            this._realtimeSubscription = null;
        }
    }

    handleRealtimeRefresh() {
        if (this.caseId) {
            getRecordNotifyChange([{ recordId: this.caseId }]);
        }
    }

    get popupTitle() {
        return this.caseNumber
            ? `Acciones r\u00E1pidas - ${this.caseNumber}`
            : 'Acciones r\u00E1pidas';
    }

    get commentCharCount() {
        return (this.commentText || '').length;
    }

    get sendDisabled() {
        return this.isReadOnly || this.saving
            || !this.commentText || this.commentText.trim().length === 0;
    }

    handlePlantillaChange(event) {
        if (this.isReadOnly) {
            return;
        }
        const value = event.detail.value;
        this.selectedPlantillaName = value;
        const p = this.plantillas.find((x) => x.name === value);
        if (p) {
            this.commentText = p.texto;
        }
    }

    handleCommentChange(event) {
        if (this.isReadOnly) {
            return;
        }
        this.commentText = event.detail.value;
    }

    handleEstadoSuccess() {
        this.toast('Estado actualizado', 'success');
        this.dispatchEvent(new CustomEvent('actiondone'));
    }

    handleEstadoError(event) {
        const msg = event.detail?.message || event.detail?.detail || 'No se pudo actualizar el estado';
        this.toast(msg, 'error');
    }

    handleEstadoSubmit(event) {
        if (this.isReadOnly) {
            event.preventDefault();
            event.stopPropagation();
            this.toast(
                'El ticket está cerrado. No se puede modificar el estado.',
                'info'
            );
        }
    }

    async handleSendComment() {
        if (this.isReadOnly) {
            this.toast('El ticket está cerrado. No se pueden enviar comentarios.', 'info');
            return;
        }
        this.saving = true;
        try {
            await addPublicCaseComment({
                caseId: this.caseId,
                texto: this.commentText
            });
            this.toast('Comentario enviado al cliente', 'success');
            this.commentText = '';
            this.selectedPlantillaName = '';
            this.dispatchEvent(new CustomEvent('actiondone'));
        } catch (e) {
            this.toast(this.reduceErrors(e), 'error');
        } finally {
            this.saving = false;
        }
    }

    handleOpenTicket() {
        if (!this.caseId) return;
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: {
                recordId: this.caseId,
                objectApiName: 'Case',
                actionName: 'view'
            }
        });
        this.handleClose();
    }

    handleClose() {
        this.dispatchEvent(new CustomEvent('close'));
    }

    reduceErrors(error) {
        if (!error) return 'Error desconocido';
        if (Array.isArray(error.body)) return error.body.map((e) => e.message).join(', ');
        if (error.body?.message) return error.body.message;
        if (typeof error.body === 'string') return error.body;
        if (error.message) return error.message;
        return 'Error al procesar la solicitud';
    }

    toast(message, variant) {
        this.dispatchEvent(
            new ShowToastEvent({
                title: variant === 'error' ? 'Error' : 'Listo',
                message,
                variant,
                mode: 'dismissable'
            })
        );
    }
}
