import { LightningElement, api } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import getSlaTicketFullHistory from '@salesforce/apex/EquipoResolutoresController.getSlaTicketFullHistory';
import isCurrentUserSlaAdmin from '@salesforce/apex/EquipoResolutoresController.isCurrentUserSlaAdmin';
import USER_ID from '@salesforce/user/Id';
import { createEquipoRealtimeSubscription } from 'c/equipoResolutoresRealtime';
import {
    mapHistoryDisplayRow,
    normalizeFullHistoryRow
} from 'c/equipoResolutoresHistorialUtil';

export default class SlaTicketHistorialModal extends NavigationMixin(
    LightningElement
) {
    _caseId;
    _loadGeneration = 0;

    @api caseNumber;
    @api isSlaAdmin;

    historyData;
    loading = true;
    loadError = null;
    nowTick = Date.now();
    _tickInterval;
    _realtimeSubscription;
    _slaAdminFromWire = false;

    @api
    get caseId() {
        return this._caseId;
    }

    set caseId(value) {
        const next = value || null;
        if (next === this._caseId) {
            return;
        }
        this._caseId = next;
        if (next) {
            this.loadHistory();
        } else {
            this.historyData = null;
            this.loadError = null;
            this.loading = false;
        }
    }

    connectedCallback() {
        this._tickInterval = setInterval(() => {
            this.nowTick = Date.now();
        }, 1000);

        this._realtimeSubscription = createEquipoRealtimeSubscription({
            userId: USER_ID,
            shouldHandle: ({ caseId }) =>
                Boolean(caseId && this._caseId && caseId === this._caseId),
            onNotify: () => this.loadHistory()
        });

        if (this._caseId) {
            this.loadHistory();
        }

        isCurrentUserSlaAdmin()
            .then((data) => {
                this._slaAdminFromWire = data === true;
            })
            .catch(() => {
                this._slaAdminFromWire = false;
            });
    }

    disconnectedCallback() {
        if (this._tickInterval) {
            clearInterval(this._tickInterval);
            this._tickInterval = null;
        }
        if (this._realtimeSubscription) {
            this._realtimeSubscription.disconnect();
            this._realtimeSubscription = null;
        }
    }

    async loadHistory() {
        if (!this._caseId) {
            return;
        }
        const gen = ++this._loadGeneration;
        this.loading = true;
        this.loadError = null;
        try {
            const data = await getSlaTicketFullHistory({ caseId: this._caseId });
            if (gen !== this._loadGeneration) {
                return;
            }
            this.historyData = data;
        } catch (e) {
            if (gen !== this._loadGeneration) {
                return;
            }
            this.historyData = { rows: [] };
            this.loadError = this.reduceError(e);
        } finally {
            if (gen === this._loadGeneration) {
                this.loading = false;
            }
        }
    }

    reduceError(e) {
        if (Array.isArray(e?.body)) {
            return e.body.map((x) => x.message).join(', ');
        }
        if (typeof e?.body?.message === 'string') {
            return e.body.message;
        }
        if (e?.message) {
            return e.message;
        }
        return 'No se pudo cargar el historial.';
    }

    get effectiveSlaAdmin() {
        return this.isSlaAdmin === true || this._slaAdminFromWire === true;
    }

    get modalTitle() {
        const num = this.caseNumber || this.historyData?.caseNumber;
        return num
            ? `Historial de responsables — ${num}`
            : 'Historial de responsables';
    }

    get headerMeta() {
        const parts = [];
        if (this.historyData?.ownerName) {
            parts.push(`Resolutor: ${this.historyData.ownerName}`);
        }
        if (this.historyData?.caseStatus) {
            parts.push(`Estado actual: ${this.historyData.caseStatus}`);
        }
        return parts.join(' · ');
    }

    get hasRows() {
        return (this.displayRows?.length || 0) > 0;
    }

    get showEmpty() {
        return !this.loading && !this.loadError && !this.hasRows;
    }

    get displayRows() {
        const caseStatus = this.historyData?.caseStatus;
        return (this.historyData?.rows || []).map((row, index) =>
            mapHistoryDisplayRow(normalizeFullHistoryRow(row), index, {
                isSlaAdmin: this.effectiveSlaAdmin,
                caseStatus,
                nowMs: this.nowTick,
                caseSlaPaused: this.historyData?.caseSlaPaused === true,
                casePauseAnchorMs: this.historyData?.casePauseAnchorMs
            })
        );
    }

    handleClose() {
        this.dispatchEvent(new CustomEvent('close'));
    }

    handleRecordNavigate(event) {
        const recordId = event.currentTarget.dataset.recordId;
        if (!recordId) {
            return;
        }
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: {
                recordId,
                objectApiName: 'Equipo_de_Resolutores__c',
                actionName: 'view'
            }
        });
    }
}
