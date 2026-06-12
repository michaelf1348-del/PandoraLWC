import { LightningElement, api, wire } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import { refreshApex } from '@salesforce/apex';
import CASE_STATUS from '@salesforce/schema/Case.Status';
import CASE_IS_STOPPED from '@salesforce/schema/Case.IsStopped';
import CASE_SUBESTADO from '@salesforce/schema/Case.SubEstado__c';
import CASE_OWNER from '@salesforce/schema/Case.OwnerId';
import CASE_IS_CLOSED from '@salesforce/schema/Case.IsClosed';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import LightningConfirm from 'lightning/confirm';
import { getPicklistValues } from 'lightning/uiObjectInfoApi';
import getTeamData from '@salesforce/apex/EquipoResolutoresController.getTeamData';
import getSlaAlert from '@salesforce/apex/EquipoResolutoresController.getSlaAlert';
import getCustodyHistory from '@salesforce/apex/EquipoResolutoresController.getCustodyHistory';
import getCustodyTimeline from '@salesforce/apex/EquipoResolutoresController.getCustodyTimeline';
import getSlaMonitorForCurrentUser from '@salesforce/apex/EquipoResolutoresController.getSlaMonitorForCurrentUser';
import getMisApoyosForCurrentUser from '@salesforce/apex/EquipoResolutoresController.getMisApoyosForCurrentUser';
import addMember from '@salesforce/apex/EquipoResolutoresController.addMember';
import transferCustody from '@salesforce/apex/EquipoResolutoresController.transferCustody';
import releaseCustody from '@salesforce/apex/EquipoResolutoresController.releaseCustody';
import USER_ID from '@salesforce/user/Id';
import updateMember from '@salesforce/apex/EquipoResolutoresController.updateMember';
import deleteMember from '@salesforce/apex/EquipoResolutoresController.deleteMember';
import getEquipoRecordTypeIdForCase from '@salesforce/apex/EquipoResolutoresController.getEquipoRecordTypeIdForCase';
import getRoleOptions from '@salesforce/apex/EquipoResolutoresController.getRoleOptions';
import isCurrentUserSlaAdmin from '@salesforce/apex/EquipoResolutoresController.isCurrentUserSlaAdmin';
import getSlaTicketFullHistory from '@salesforce/apex/EquipoResolutoresController.getSlaTicketFullHistory';
import { createEquipoRealtimeSubscription } from 'c/equipoResolutoresRealtime';
import {
    mapHistoryDisplayRow,
    normalizeFullHistoryRow
} from 'c/equipoResolutoresHistorialUtil';

const EQUIPO_RESOLUTOR_FIELD = {
    fieldApiName: 'Equipo_Resolutor__c',
    objectApiName: 'Equipo_de_Resolutores__c'
};

/** Sondeo de respaldo si empApi no entrega (PE + foco cubren lo habitual). */
const SLA_REFRESH_MS = 60000;

export default class EquipoResolutores extends NavigationMixin(LightningElement) {
    @api recordId;

    teamData = {};
    slaAlert = {};
    historyRows = [];
    historyNow = Date.now();
    timelineSegments = [];
    timelineLegend = [];
    slaMonitorAllRows = [];
    slaStatusFilter = 'all';
    slaSearchTerm = '';
    wiredTeamResult;
    wiredSlaResult;
    wiredHistoryResult;
    wiredTimelineResult;

    showAddModal = false;
    showEditModal = false;
    showSlaMonitorModal = false;
    slaModalMode = 'monitor';
    showHistory = false;
    showHistoryModal = false;
    showMonitorHomeModal = false;
    isSlaAdmin = false;
    _historyMode = 'custody';
    _fullHistorySource = [];
    slaMonitorLoading = false;

    _lastCaseStatus;
    _lastCaseSubStatus;
    _lastCaseStopped;
    _lastCaseOwner;
    _caseIsClosedFlag = false;
    _wiredCaseStatus;

    showCustodyModal = false;
    custodyMode = '';
    custodyTargetUserId = null;
    custodyTargetName = '';
    custodyReason = '';

    showTeamPanel = false;
    showStatusMenu = false;
    chipMenuUserId = null;
    memberSearch = '';
    memberSort = 'default';
    memberFilter = 'all';
    custodyTimerValue = '';
    custodyTimerSuffix = '';

    newMemberUserId;
    newMemberRole;
    editRecordId;
    editMemberName;
    editRole;
    editNotes;
    roleOptions = [];
    equipoRecordTypeId;
    custodyTimerDisplay = '';
    _custodyOverdue = false;

    _custodyTimerInterval;
    _slaRefreshInterval;
    _pauseFreezeMs;
    _realtimeSubscription;

    @wire(getRecord, {
        recordId: '$recordId',
        fields: [CASE_STATUS, CASE_IS_STOPPED, CASE_SUBESTADO, CASE_OWNER, CASE_IS_CLOSED]
    })
    wiredCaseRecord({ data }) {
        if (!data) {
            return;
        }
        const status = getFieldValue(data, CASE_STATUS);
        const subStatus = getFieldValue(data, CASE_SUBESTADO);
        const stopped = getFieldValue(data, CASE_IS_STOPPED);
        const owner = getFieldValue(data, CASE_OWNER);
        this._caseIsClosedFlag = getFieldValue(data, CASE_IS_CLOSED) === true;
        this._wiredCaseStatus = status;

        const hasSnapshot = this._lastCaseStatus !== undefined;
        const changed = hasSnapshot && (
            status !== this._lastCaseStatus
            || subStatus !== this._lastCaseSubStatus
            || stopped !== this._lastCaseStopped
            || owner !== this._lastCaseOwner
        );

        this._lastCaseStatus = status;
        this._lastCaseSubStatus = subStatus;
        this._lastCaseStopped = stopped;
        this._lastCaseOwner = owner;

        if (changed) {
            this.refreshTeamAndSla();
        }
    }

    @wire(getTeamData, { caseId: '$recordId' })
    wiredTeam(result) {
        this.wiredTeamResult = result;
        if (result.data) {
            this.teamData = result.data;
            this.tickCustodyTimer();
        }
    }

    @wire(getSlaAlert, { caseId: '$recordId' })
    wiredSla(result) {
        this.wiredSlaResult = result;
        if (result.data) {
            this.slaAlert = result.data;
        }
    }

    @wire(getCustodyHistory, { caseId: '$recordId' })
    wiredHistory(result) {
        this.wiredHistoryResult = result;
        if (result.data) {
            this.historyRows = result.data.map((row, index) => {
                const enriched = {
                    ...row,
                    entryType: 'Custodia',
                    isOpen: row.finLabel === 'En curso',
                    isCurrentResponsible:
                        row.finLabel === 'En curso'
                        && row.consultantName === this.currentCustodianName
                };
                return this.mapHistoryRow(enriched, index);
            });
        }
    }

    @wire(getCustodyTimeline, { caseId: '$recordId' })
    wiredTimeline(result) {
        this.wiredTimelineResult = result;
        if (result.data) {
            this.buildTimeline(result.data);
        }
    }

    @wire(getEquipoRecordTypeIdForCase, { caseId: '$recordId' })
    wiredRt(result) {
        if (result.data) {
            this.equipoRecordTypeId = result.data;
        }
    }

    @wire(getPicklistValues, {
        recordTypeId: '$equipoRecordTypeId',
        fieldApiName: EQUIPO_RESOLUTOR_FIELD
    })
    wiredPicklist({ data }) {
        if (data?.values?.length) {
            this.roleOptions = data.values.map((v) => ({
                label: v.label,
                value: v.value
            }));
        }
    }

    @wire(isCurrentUserSlaAdmin)
    wiredSlaAdmin({ data }) {
        this.isSlaAdmin = data === true;
    }

    @wire(getRoleOptions, { caseId: '$recordId' })
    wiredApexRoles({ data }) {
        if (data?.length && this.roleOptions.length === 0) {
            this.roleOptions = data.map((o) => ({
                label: o.label,
                value: o.value
            }));
        }
    }

    connectedCallback() {
        this._custodyTimerInterval = setInterval(() => this.tickCustodyTimer(), 1000);
        this._slaRefreshInterval = setInterval(() => this.refreshSla(), SLA_REFRESH_MS);

        // Refresco instantáneo al volver el foco a la pestaña/ventana, para reflejar
        // cambios de equipo/custodia hechos por otros usuarios sin esperar al sondeo.
        this._onVisibility = () => {
            if (document.visibilityState === 'visible') {
                this.refreshOnFocus();
            }
        };
        this._onWindowFocus = () => this.refreshOnFocus();
        document.addEventListener('visibilitychange', this._onVisibility);
        window.addEventListener('focus', this._onWindowFocus);

        this._realtimeSubscription = createEquipoRealtimeSubscription({
            userId: USER_ID,
            shouldHandle: ({ caseId }) =>
                Boolean(caseId && this.recordId && caseId === this.recordId),
            onNotify: () => this.handleRealtimeTeamUpdate()
        });
    }

    /** Refresca equipo/SLA cuando vuelve el foco, con anti-rebote de 4s. */
    refreshOnFocus() {
        const now = Date.now();
        if (this._lastFocusRefreshMs && now - this._lastFocusRefreshMs < 4000) {
            return;
        }
        this._lastFocusRefreshMs = now;
        this.refreshTeamAndSla();
    }

    disconnectedCallback() {
        clearInterval(this._custodyTimerInterval);
        clearInterval(this._slaRefreshInterval);
        if (this._onVisibility) {
            document.removeEventListener('visibilitychange', this._onVisibility);
        }
        if (this._onWindowFocus) {
            window.removeEventListener('focus', this._onWindowFocus);
        }
        if (this._realtimeSubscription) {
            this._realtimeSubscription.disconnect();
            this._realtimeSubscription = null;
        }
    }

    get ownerName() {
        return this.teamData?.ownerName;
    }

    get ownerPhotoUrl() {
        return this.teamData?.ownerPhotoUrl;
    }

    get currentCustodianName() {
        return this.teamData?.currentCustodianName;
    }

    get hasActiveCustody() {
        return Boolean(this.teamData?.currentCustodyStartMs);
    }

    get caseStatus() {
        return this.teamData?.caseStatus;
    }

    get caseSubStatus() {
        return this.teamData?.caseSubStatus;
    }

    get caseNumber() {
        return this.teamData?.caseNumber;
    }

    get hasCaseState() {
        return Boolean(this.teamData?.caseStatus);
    }

    get custodyPaused() {
        return this.teamData?.custodyPaused === true;
    }

    get custodyTimerClass() {
        let cls = 'custody-timer';
        if (this.custodyPaused) {
            cls += ' custody-timer_paused';
        } else if (this._custodyOverdue) {
            cls += ' custody-timer_overdue';
        }
        return cls;
    }

    get targetDateMs() {
        const t = this.slaAlert?.targetDate;
        if (!t && t !== 0) {
            return null;
        }
        if (typeof t === 'number') {
            return t;
        }
        const parsed = Date.parse(t);
        return isNaN(parsed) ? null : parsed;
    }

    get summaryCellCustodyClass() {
        return this.currentCustodianName
            ? 'summary-cell summary-cell_active'
            : 'summary-cell';
    }

    get showOwnerMismatchAlert() {
        const owner = this.teamData?.ownerId;
        const custodian = this.teamData?.currentCustodianId;
        return Boolean(owner && custodian && owner !== custodian);
    }

    get showTransferToOwnerOption() {
        return this.canManageTeam && this.showOwnerMismatchAlert;
    }

    get ownerMismatchMessage() {
        const custodian = this.teamData?.currentCustodianName || 'otra persona';
        const owner = this.teamData?.ownerName || 'el resolutor';
        return `El responsable es ${custodian}, pero el resolutor es ${owner}. Revisá si corresponde transferir.`;
    }

    get showSlaAlert() {
        return this.slaAlert?.hasAlert === true;
    }

    get slaAlertClass() {
        const status = this.slaAlert?.status || 'ok';
        return `sla-alert sla-alert_${status}`;
    }

    get slaAlertIcon() {
        const map = {
            ok: 'utility:success',
            warning: 'utility:warning',
            danger: 'utility:error',
            violated: 'utility:ban'
        };
        return map[this.slaAlert?.status] || 'utility:info';
    }

    get slaMilestoneName() {
        return this.slaAlert?.milestoneName || 'Evento clave';
    }

    /** Texto fuerte bajo "Estado": hito activo o "Ticket cerrado" si está cerrado. */
    get estadoStrongLabel() {
        return this.isCaseClosed ? 'Ticket cerrado' : this.slaMilestoneName;
    }

    get slaAlertDetail() {
        return this.slaAlert?.message || '';
    }

    get canReleaseCustody() {
        return (
            this.hasActiveCustody &&
            this.teamData?.currentCustodianId === USER_ID
        );
    }

    get historyActiveSections() {
        return this.showHistory ? 'history' : '';
    }

    get teamSectionTitle() {
        const n = this.members.length;
        return `Equipo de apoyo (${n})`;
    }

    get historyAccordionLabel() {
        return `Historial de responsables (${this.historyRows.length})`;
    }

    get hasHistory() {
        return (this.historyRows?.length || 0) > 0;
    }

    get slaMonitorRows() {
        return this.filterMonitorRows(this.slaMonitorAllRows);
    }

    get hasSlaMonitorRows() {
        return this.slaMonitorAllRows.length > 0;
    }

    get hasFilteredSlaRows() {
        return this.slaMonitorRows.length > 0;
    }

    get showTeamColumn() {
        return this.slaModalMode === 'team';
    }

    get slaFilterOptions() {
        return [
            { label: 'Todos', value: 'all' },
            { label: 'Infracción', value: 'violated' },
            { label: 'Infracci\u00F3n', value: 'violated' },
            { label: 'Riesgo', value: 'warning' },
            { label: 'OK', value: 'ok' }
        ];
    }

    get slaModalTitle() {
        return this.slaModalMode === 'apoyos'
            ? 'Mis apoyos'
            : 'Monitor SLA — mis tickets';
    }

    get slaMonitorSummary() {
        const total = this.slaMonitorAllRows.length;
        const shown = this.slaMonitorRows.length;
        const bad = this.slaMonitorAllRows.filter(
            (r) => r.slaStatus === 'violated'
        ).length;
        if (total === 0) {
            return this.slaModalMode === 'apoyos'
                ? 'No tenés tickets como apoyo o responsable'
                : 'Sin tickets abiertos asignados';
        }
        let base =
            shown === total
                ? `${total} tickets`
                : `${shown} de ${total} tickets`;
        if (bad > 0) {
            base += ` · ${bad} críticos`;
        }
        return base;
    }

    filterMonitorRows(rows) {
        let list = rows || [];
        if (this.slaStatusFilter !== 'all') {
            list = list.filter((r) => r.slaStatus === this.slaStatusFilter);
        }
        const q = (this.slaSearchTerm || '').trim().toLowerCase();
        if (q) {
            list = list.filter(
                (r) =>
                    (r.caseNumber && r.caseNumber.toLowerCase().includes(q)) ||
                    (r.subject && r.subject.toLowerCase().includes(q)) ||
                    (r.milestoneName && r.milestoneName.toLowerCase().includes(q)) ||
                    (r.consultantName && r.consultantName.toLowerCase().includes(q))
            );
        }
        return list;
    }

    handleSlaFilterChange(event) {
        this.slaStatusFilter = event.detail.value;
    }

    handleSlaSearchChange(event) {
        this.slaSearchTerm = event.detail.value;
    }

    get memberList() {
        const raw = this.teamData?.members;
        if (Array.isArray(raw)) {
            return raw;
        }
        if (raw && typeof raw === 'object') {
            return Object.values(raw);
        }
        return [];
    }

    get members() {
        const manage = this.canManageTeam;
        return this.memberList.map((m) => {
            const showRelease = manage
                && m.isCurrentCustodian
                && this.teamData?.currentCustodianId === USER_ID;
            const showDelete = manage && !m.isOwner && m.canEdit;
            const showEdit = manage && !m.isOwner && m.canEdit;
            return {
                ...m,
                showActions: manage && (m.canEdit || m.canDelete),
                initials: this.initialsOf(m.userName),
                avatarStyle: `background-color:${this.colorFor(m.userName)}`,
                statusLabel: m.isCurrentCustodian ? 'Responsable activo' : 'Disponible',
                statusClass: m.isCurrentCustodian
                    ? 'member-status member-status_active'
                    : 'member-status',
                showTomar: manage && !m.isCurrentCustodian,
                tomarLabel: 'Asignar',
                showRelease,
                showDelete,
                showEdit,
                showMenu: showRelease || showDelete || showEdit,
                cardClass: m.isCurrentCustodian
                    ? 'member-card member-card_active'
                    : 'member-card'
            };
        });
    }

    get hasMembers() {
        return this.members.length > 0;
    }

    get filteredMembers() {
        let list = this.members.slice();
        if (this.memberFilter === 'available') {
            list = list.filter((m) => !m.isCurrentCustodian);
        } else if (this.memberFilter === 'responsible') {
            list = list.filter((m) => m.isCurrentCustodian);
        }
        const q = (this.memberSearch || '').trim().toLowerCase();
        if (q) {
            list = list.filter(
                (m) => m.userName && m.userName.toLowerCase().includes(q)
            );
        }
        if (this.memberSort === 'name') {
            list.sort((a, b) =>
                (a.userName || '').localeCompare(b.userName || ''));
        } else if (this.memberSort === 'role') {
            list.sort((a, b) => (a.role || '').localeCompare(b.role || ''));
        } else {
            // Predeterminado: el responsable activo primero.
            list.sort((a, b) =>
                (b.isCurrentCustodian ? 1 : 0) - (a.isCurrentCustodian ? 1 : 0));
        }
        return list;
    }

    get hasFilteredMembers() {
        return this.filteredMembers.length > 0;
    }

    get apoyosCount() {
        return this.memberList.length;
    }

    /** Solo el resolutor del ticket (sin apoyos adicionales en el equipo). */
    get isResolverOnly() {
        return this.memberList.length <= 1;
    }

    /** Hay más personas además del resolutor (apoyos en el equipo). */
    get hasSupportTeam() {
        return this.memberList.length > 1;
    }

    get custodianIsOwner() {
        const ownerId = this.teamData?.ownerId;
        const custodianId = this.teamData?.currentCustodianId;
        return Boolean(ownerId && custodianId && ownerId === custodianId);
    }

    /**
     * El resolutor (owner) tiene la custodia activa. Cubre el caso de devolver
     * la custodia al resolutor tras haberla pasado a un apoyo, sin depender del
     * tamaño del equipo.
     */
    get custodyHeldByOwner() {
        const ownerId = this.teamData?.ownerId;
        const custodianId = this.teamData?.currentCustodianId;
        if (ownerId && custodianId) {
            return ownerId === custodianId;
        }
        // Sin custodio explícito: si solo está el resolutor, lo tiene él.
        return this.isResolverOnly;
    }

    get responsablesLabel() {
        const n = this.apoyosCount || 1;
        return this.isResolverOnly ? `Responsable (${n})` : `Responsables (${n})`;
    }

    /** Cierre por IsClosed o por Status (p. ej. Cierre antes de que IsClosed se actualice). */
    get isCaseClosed() {
        return this._caseIsClosedFlag
            || this.isClosureStatus(this._wiredCaseStatus)
            || this.isClosureStatus(this.teamData?.caseStatus);
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

    /** Ticket cerrado: sin entitlement activo. Solo lectura, sin conteo SLA. */
    get canManageTeam() {
        return !this.isCaseClosed;
    }

    get statusMenuDisabled() {
        return this.isCaseClosed;
    }

    /** Hay contador SLA visible en alguna zona del componente. */
    get shouldShowLiveTimer() {
        if (this.isCaseClosed) {
            return false;
        }
        return this.showTimerUnderEtapa || this.showTimerUnderChips;
    }

    /**
     * Contador bajo Estado: el resolutor (owner) tiene la custodia. Se muestra
     * tanto si está solo como si devolvió/recuperó la custodia teniendo equipo.
     */
    get showTimerUnderEtapa() {
        if (this.isCaseClosed || !this.custodyHeldByOwner) {
            return false;
        }
        return Boolean(this.targetDateMs || this.hasActiveCustody);
    }

    /** Texto estático bajo Estado (resolutor tiene el caso, sin contador activo). */
    get showEtapaDueShort() {
        if (this.isCaseClosed) {
            return false;
        }
        return this.custodyHeldByOwner && !this.showTimerUnderEtapa;
    }

    /** Contador bajo avatares: otro consultor (no el resolutor) tiene la custodia. */
    get showTimerUnderChips() {
        if (this.isCaseClosed) {
            return false;
        }
        return (
            this.hasActiveCustody
            && !this.custodyHeldByOwner
            && Boolean(this.targetDateMs || this.teamData?.currentCustodyStartMs)
        );
    }

    get showVerEquipo() {
        return this.hasSupportTeam;
    }

    get apoyosRowClass() {
        const base = 'apoyos-row';
        return this.showTeamPanel ? `${base} apoyos-row_open` : base;
    }

    get historyModalTitle() {
        const num = this.caseNumber;
        return num
            ? `Historial de responsables — ${num}`
            : 'Historial de responsables';
    }

    get avatarChips() {
        const max = 4;
        const manage = this.canManageTeam;
        return this.members.slice(0, max).map((m, i) => {
            const canRemove = manage && !m.isOwner && m.canEdit;
            const menuOpen = canRemove && this.chipMenuUserId === m.userId;
            return {
                key: `chip-${m.userId || i}`,
                userId: m.userId,
                userName: m.userName,
                initials: m.initials,
                colorStyle: m.avatarStyle,
                isCurrentCustodian: m.isCurrentCustodian,
                chipClass: m.isCurrentCustodian
                    ? 'apoyo-chip apoyo-chip_btn apoyo-chip_active'
                    : 'apoyo-chip apoyo-chip_btn',
                title: canRemove
                    ? `${m.userName} — clic para opciones`
                    : (m.isCurrentCustodian
                        ? `Responsable activo: ${m.userName}`
                        : `Asignar como responsable: ${m.userName}`),
                canRemove,
                assignDisabled: !manage || (!canRemove && m.isCurrentCustodian),
                showDropdown: menuOpen,
                showAssignInMenu: canRemove && !m.isCurrentCustodian
            };
        });
    }

    get chipOverflowCount() {
        const max = 4;
        return Math.max(0, this.members.length - max);
    }

    get hasChipOverflow() {
        return this.chipOverflowCount > 0;
    }

    get teamPanelChevron() {
        return this.showTeamPanel ? 'utility:chevronup' : 'utility:chevrondown';
    }

    get historyChevron() {
        return this.showHistory ? 'utility:chevronup' : 'utility:chevronright';
    }

    get teamStatus() {
        if (this.isCaseClosed) {
            return { key: 'closed', label: 'Cerrado' };
        }
        if (this.custodyPaused) {
            return { key: 'paused', label: 'Pausado' };
        }
        if (this.currentCustodianName) {
            return { key: 'active', label: 'Activo' };
        }
        if (this.members.length === 0) {
            return { key: 'none', label: 'Sin equipo' };
        }
        return { key: 'review', label: 'En revisión' };
    }

    get statusBadgeClass() {
        return `status-badge status-badge_${this.teamStatus.key}`;
    }

    get statusDotClass() {
        return `status-dot status-dot_${this.teamStatus.key}`;
    }

    get statusLabel() {
        return this.teamStatus.label;
    }

    get statusChevron() {
        return this.showStatusMenu ? 'utility:chevronup' : 'utility:chevrondown';
    }

    get teamStatusOptions() {
        const current = this.teamStatus.key;
        const defs = [
            { key: 'active', label: 'Activo', desc: 'Flujo de resolución vigente' },
            { key: 'paused', label: 'Pausado', desc: 'SLA detenido, sin reasignaciones' },
            { key: 'closed', label: 'Cerrado', desc: 'El caso o etapa ya terminó' },
            { key: 'none', label: 'Sin equipo', desc: 'Aún no hay resolutores' },
            { key: 'review', label: 'En revisión', desc: 'Pendiente de validación' }
        ];
        return defs.map((d) => ({
            ...d,
            dotClass: `status-dot status-dot_${d.key}`,
            itemClass: d.key === current
                ? 'status-menu-item status-menu-item_current'
                : 'status-menu-item'
        }));
    }

    get slaRingStyle() {
        const map = { ok: 86, warning: 55, danger: 22, violated: 100 };
        const status = this.slaAlert?.status || 'ok';
        const pct = map[status] ?? 70;
        const color = status === 'danger' || status === 'violated'
            ? '#ea001e'
            : (status === 'warning' ? '#fe9339' : '#2e844a');
        const deg = Math.round((pct / 100) * 360);
        return `background:conic-gradient(${color} ${deg}deg, #e5e5e5 ${deg}deg);`;
    }

    get memberFilterOptions() {
        return [
            { label: 'Todos', value: 'all' },
            { label: 'Disponibles', value: 'available' },
            { label: 'Responsable activo', value: 'responsible' }
        ];
    }

    get sortIsDefault() {
        return this.memberSort === 'default';
    }

    get sortIsName() {
        return this.memberSort === 'name';
    }

    get sortIsRole() {
        return this.memberSort === 'role';
    }

    get filterIsAll() {
        return this.memberFilter === 'all';
    }

    get filterIsAvailable() {
        return this.memberFilter === 'available';
    }

    get filterIsResponsible() {
        return this.memberFilter === 'responsible';
    }

    get lastResponsibleName() {
        const first = this.historyRows?.[0];
        return first?.consultantName || '';
    }

    get lastResponsibleSummary() {
        const name =
            this.currentCustodianName
            || this.historyRows?.[0]?.consultantName;
        if (!name) {
            return '';
        }
        const estado =
            this.teamData?.caseStatus
            || this.historyRows?.[0]?.estadoDisplay;
        return estado ? `Último: ${name} · ${estado}` : `Último: ${name}`;
    }

    toggleStatusMenu() {
        if (this.statusMenuDisabled) {
            return;
        }
        this.showStatusMenu = !this.showStatusMenu;
    }

    closeStatusMenu() {
        this.showStatusMenu = false;
    }

    closeTeamPanel() {
        this.showTeamPanel = false;
    }

    closeChipMenu() {
        this.chipMenuUserId = null;
    }

    handleMemberFilter(event) {
        this.memberFilter = event.detail.value;
    }

    handleMemberMenuSelect(event) {
        const action = event.detail.value;
        const userId = event.currentTarget.dataset.userId;
        if (action === 'edit') {
            this.openEditModalById(userId);
        } else if (action === 'delete') {
            this.deleteMemberById(userId);
        } else if (action === 'release') {
            this.openReleaseModal();
        }
    }

    get memberSortOptions() {
        return [
            { label: 'Predeterminado', value: 'default' },
            { label: 'Nombre (A-Z)', value: 'name' },
            { label: 'Rol', value: 'role' }
        ];
    }

    get slaKpiIcon() {
        const map = {
            ok: 'utility:check',
            warning: 'utility:clock',
            danger: 'utility:warning',
            violated: 'utility:ban'
        };
        return map[this.slaAlert?.status] || 'utility:clock';
    }

    get slaKpiIconClass() {
        const status = this.slaAlert?.status || 'ok';
        return `kpi-sla-icon kpi-sla-icon_${status}`;
    }

    get slaIconVariant() {
        const map = {
            ok: 'success',
            warning: 'warning',
            danger: 'error',
            violated: 'error'
        };
        return map[this.slaAlert?.status] || 'success';
    }

    get currentCustodianInitials() {
        return this.currentCustodianName
            ? this.initialsOf(this.currentCustodianName)
            : '—';
    }

    get currentCustodianStyle() {
        const name = this.currentCustodianName;
        if (!name) {
            return 'background-color:#c9c7c5;';
        }
        return `background-color:${this.colorFor(name)};`;
    }

    get slaDueShort() {
        const targetMs = this.targetDateMs;
        if (targetMs) {
            const remaining = targetMs - Date.now();
            if (remaining < 0) {
                return 'SLA en infracci\u00F3n';
            }
            const totalMin = Math.floor(remaining / 60000);
            const h = Math.floor(totalMin / 60);
            if (h >= 1) {
                return `Vence en ${h} h`;
            }
            return `Vence en ${totalMin} min`;
        }
        return this.slaAlert?.message || 'Sin evento clave activo';
    }

    get ownerMenuItems() {
        return {
            showTransferToOwner: this.showOwnerMismatchAlert
        };
    }

    initialsOf(name) {
        if (!name) {
            return '?';
        }
        const parts = name.trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
            return '?';
        }
        if (parts.length === 1) {
            return parts[0].substring(0, 2).toUpperCase();
        }
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    colorFor(name) {
        const palette = [
            '#1b96ff', '#9050e9', '#06a59a', '#fe9339',
            '#e16032', '#3296ed', '#794bc4', '#0b827c', '#2e844a'
        ];
        const key = name || '';
        let hash = 0;
        for (let i = 0; i < key.length; i++) {
            hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
        }
        return palette[hash % palette.length];
    }

    toggleTeamPanel() {
        this.closeChipMenu();
        this.showTeamPanel = !this.showTeamPanel;
    }

    handleMemberSearch(event) {
        this.memberSearch = event.detail.value;
    }

    handleMemberSort(event) {
        this.memberSort = event.detail.value;
    }

    toggleHistory() {
        this.showHistory = !this.showHistory;
    }

    /** Tiempo efectivo (ms) de la custodia actual, congelado si está en pausa. */
    get currentCustodyLiveElapsedMs() {
        const startMs = this.teamData?.currentCustodyStartMs;
        if (!startMs) {
            return null;
        }
        const nowMs = this.historyNow || Date.now();
        const pauseStartMs = this.teamData?.currentCustodyPauseStartMs;
        const pausedMin = this.teamData?.currentCustodyPausedMin || 0;
        let nowRef;
        if (this.custodyPaused) {
            nowRef = pauseStartMs || this._pauseFreezeMs || nowMs;
        } else {
            nowRef = nowMs;
        }
        return Math.max(0, nowRef - startMs - pausedMin * 60000);
    }

    /**
     * Historial con la duración del responsable actual calculada en tiempo real
     * (con segundos). Las filas cerradas conservan su valor del servidor.
     */
    get liveHistoryRows() {
        const rows = this.historyRows || [];
        const liveMs = this.currentCustodyLiveElapsedMs;
        const fallbackEstado = this.teamData?.caseStatus;
        return rows.map((r, index) => {
            const mapped = {
                consultantName: r.consultantName,
                estado: r.estado,
                equipo: r.equipo,
                inicioLabel: r.inicioLabel,
                finLabel: r.finLabel,
                durationLabel: r.durationLabel,
                pausedLabel: r.pausedLabel,
                hadViolation: r.hadViolation,
                equipoRecordId: r.equipoRecordId,
                isOpen: r.finLabel === 'En curso',
                inicioMs: null,
                entryType: 'Custodia'
            };
            const display = mapHistoryDisplayRow(mapped, index, {
                isSlaAdmin: this.isSlaAdmin,
                caseStatus: fallbackEstado,
                nowMs: this.historyNow
            });
            if (mapped.isOpen && liveMs != null) {
                const live = this.formatElapsed(liveMs);
                return {
                    ...display,
                    durationLabel: live,
                    durationMeta: r.pausedLabel ? `${live} · ${r.pausedLabel}` : live
                };
            }
            return display;
        });
    }

    get fullHistoryLiveRows() {
        const caseStatus = this.teamData?.caseStatus;
        const meta = this._fullHistoryMeta || {};
        const caseSlaPaused =
            meta.caseSlaPaused === true || this.custodyPaused === true;
        const casePauseAnchorMs =
            meta.casePauseAnchorMs
            || this.teamData?.currentCustodyPauseStartMs
            || null;
        return (this._fullHistorySource || []).map((row, index) =>
            mapHistoryDisplayRow(normalizeFullHistoryRow(row), index, {
                isSlaAdmin: this.isSlaAdmin,
                caseStatus,
                nowMs: this.historyNow,
                caseSlaPaused,
                casePauseAnchorMs
            })
        );
    }

    get modalHistoryRows() {
        return this.fullHistoryLiveRows;
    }

    async handleRealtimeTeamUpdate() {
        await this.refreshTeamAndSla();
        if (this.showHistoryModal) {
            await this.loadFullHistoryRows();
        }
    }

    async loadFullHistoryRows() {
        const data = await getSlaTicketFullHistory({ caseId: this.recordId });
        this._fullHistorySource = data?.rows || [];
        this._fullHistoryMeta = {
            caseSlaPaused: data?.caseSlaPaused === true,
            casePauseAnchorMs: data?.casePauseAnchorMs
        };
        this._historyMode = 'full';
    }

    mapHistoryRow(row, index) {
        return mapHistoryDisplayRow(row, index, {
            isSlaAdmin: this.isSlaAdmin,
            caseStatus: this.teamData?.caseStatus,
            nowMs: this.historyNow
        });
    }

    async openHistoryModal() {
        try {
            await this.loadFullHistoryRows();
            this.showHistoryModal = true;
        } catch (e) {
            this.toast(this.reduceErrors(e), 'error');
        }
    }

    closeHistoryModal() {
        this.showHistoryModal = false;
        this._fullHistorySource = [];
    }

    handleHistoryRecordNavigate(event) {
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

    openSlaMonitorHome() {
        this.showMonitorHomeModal = true;
    }

    closeMonitorHomeModal() {
        this.showMonitorHomeModal = false;
    }

    /** Bloquea acciones que afectan SLA cuando el ticket está cerrado. */
    blockIfClosed() {
        if (this.isCaseClosed) {
            this.toast(
                'El ticket está cerrado. No se pueden modificar responsables ni el SLA.',
                'info'
            );
            return true;
        }
        return false;
    }

    handleChipClick(event) {
        event.stopPropagation();
        if (this.isCaseClosed) {
            return;
        }
        const userId = event.currentTarget.dataset.userId;
        const canRemove = event.currentTarget.dataset.canRemove === 'true';
        if (canRemove) {
            this.chipMenuUserId = this.chipMenuUserId === userId ? null : userId;
            return;
        }
        this.closeChipMenu();
        this.openTransferModal(event);
    }

    handleChipMenuAssign(event) {
        event.stopPropagation();
        this.closeChipMenu();
        if (this.blockIfClosed()) {
            return;
        }
        this.openTransferModal(event);
    }

    async handleChipMenuRemove(event) {
        event.stopPropagation();
        this.closeChipMenu();
        if (this.blockIfClosed()) {
            return;
        }
        const userId = event.currentTarget.dataset.userId;
        await this.deleteMemberById(userId);
    }

    handleOwnerMenuSelect(event) {
        const action = event.detail.value;
        if (action === 'transferToOwner') {
            this.transferToOwner();
        }
    }

    transferToOwner() {
        if (this.blockIfClosed()) {
            return;
        }
        const ownerId = this.teamData?.ownerId;
        if (!ownerId) {
            return;
        }
        this.custodyMode = 'transfer';
        this.custodyTargetUserId = ownerId;
        this.custodyTargetName = this.ownerName || 'el resolutor del ticket';
        this.custodyReason = '';
        this.showCustodyModal = true;
    }

    get addDisabled() {
        return !this.newMemberUserId || !this.newMemberRole;
    }

    get editDisabled() {
        return !this.editRole;
    }

    get roleOptionsEmpty() {
        return this.showAddModal && this.roleOptions.length === 0;
    }

    tickCustodyTimer() {
        // Reloj para el historial en vivo (custodia actual), independiente del
        // contador SLA bajo Estado/avatares.
        this.historyNow = Date.now();

        if (!this.shouldShowLiveTimer) {
            this.custodyTimerDisplay = '';
            this.custodyTimerValue = '';
            this.custodyTimerSuffix = '';
            this._custodyOverdue = false;
            return;
        }

        const startMs = this.teamData?.currentCustodyStartMs;
        if (!startMs && !this.targetDateMs) {
            this.custodyTimerDisplay = '';
            this.custodyTimerValue = '';
            this.custodyTimerSuffix = '';
            this._custodyOverdue = false;
            return;
        }

        const pauseStartMs = this.teamData?.currentCustodyPauseStartMs;
        // Mientras esta pausado (SubEstado que detiene el SLA o pausa explícita),
        // congelamos el contador. Si hay instante de pausa lo usamos; si no,
        // congelamos en el primer tick de la pausa.
        let nowRef;
        if (this.custodyPaused) {
            if (pauseStartMs) {
                this._pauseFreezeMs = null;
                nowRef = pauseStartMs;
            } else {
                if (!this._pauseFreezeMs) {
                    this._pauseFreezeMs = Date.now();
                }
                nowRef = this._pauseFreezeMs;
            }
        } else {
            this._pauseFreezeMs = null;
            nowRef = Date.now();
        }

        const targetMs = this.targetDateMs;
        if (targetMs) {
            const remaining = targetMs - nowRef;
            this._custodyOverdue = remaining < 0;
            const magnitude = this.formatElapsed(Math.abs(remaining));
            this.custodyTimerValue = magnitude;
            this.custodyTimerSuffix = remaining < 0 ? 'infracci\u00F3n' : 'restante';
            this.custodyTimerDisplay = remaining < 0
                ? `infracci\u00F3n hace ${magnitude}`
                : `${magnitude} restante`;
            return;
        }

        // Sin hito activo: tiempo efectivo transcurrido (descontando pausas).
        // nowRef ya está congelado si el caso está en pausa.
        const pausedMin = this.teamData?.currentCustodyPausedMin || 0;
        const elapsed = nowRef - startMs - pausedMin * 60000;
        this._custodyOverdue = false;
        const magnitude = this.formatElapsed(Math.max(0, elapsed));
        this.custodyTimerValue = magnitude;
        this.custodyTimerSuffix = 'en custodia';
        this.custodyTimerDisplay = magnitude;
    }

    get hasTimeline() {
        return this.timelineSegments.length > 0;
    }

    buildTimeline(data) {
        const segments = data?.segments || [];
        const spanStart = data?.startMs;
        const spanEnd = data?.endMs;
        const span = spanEnd && spanStart ? spanEnd - spanStart : 0;

        if (!segments.length || span <= 0) {
            this.timelineSegments = [];
            this.timelineLegend = [];
            return;
        }

        const palette = [
            '#1b96ff', '#9050e9', '#06a59a', '#fe9339',
            '#e16032', '#3296ed', '#794bc4', '#0b827c'
        ];
        const colorByName = {};
        let colorIdx = 0;
        const legend = [];

        this.timelineSegments = segments.map((s, i) => {
            const segSpan = Math.max(0, (s.endMs || spanEnd) - s.startMs);
            const widthPct = Math.max(0.8, (segSpan / span) * 100);

            let color = '#c9c7c5';
            if (!s.isGap) {
                if (!colorByName[s.consultantName]) {
                    color = palette[colorIdx % palette.length];
                    colorByName[s.consultantName] = color;
                    legend.push({
                        name: s.consultantName,
                        colorStyle: `background-color:${color}`
                    });
                    colorIdx++;
                } else {
                    color = colorByName[s.consultantName];
                }
            }

            const pausedMs = (s.pausedMin || 0) * 60000;
            const pausePct = segSpan > 0
                ? Math.min(100, (pausedMs / segSpan) * 100)
                : 0;

            const tooltip = s.isGap
                ? `Sin responsable (${this.formatElapsed(segSpan)})`
                : `${s.consultantName}` +
                  (s.estado ? ` · ${s.estado}` : '') +
                  ` · ${s.startLabel} → ${s.endLabel}` +
                  (pausePct > 0 ? ` · pausa ${this.formatElapsed(pausedMs)}` : '');

            let segClass = 'tl-seg';
            if (s.isGap) {
                segClass += ' tl-seg_gap';
            }
            if (s.isActive) {
                segClass += ' tl-seg_active';
            }

            return {
                key: `tl-${i}`,
                segClass,
                styleWidth: `width:${widthPct}%`,
                styleBg: s.isGap ? '' : `background-color:${color}`,
                showPause: pausePct > 0,
                pauseStyle: `width:${pausePct}%`,
                tooltip
            };
        });
        this.timelineLegend = legend;
    }

    formatElapsed(ms) {
        const totalSec = Math.max(0, Math.floor(ms / 1000));
        const d = Math.floor(totalSec / 86400);
        const h = Math.floor((totalSec % 86400) / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const pad = (n) => String(n).padStart(2, '0');
        if (d > 0) {
            const dayWord = d === 1 ? 'día' : 'días';
            return `${d} ${dayWord}, ${h} h, ${pad(m)} min, ${pad(s)} s`;
        }
        if (h > 0) {
            return `${h} h, ${pad(m)} min, ${pad(s)} s`;
        }
        return `${m}m ${pad(s)}s`;
    }

    async refreshTeam() {
        await this.refreshTeamAndSla();
        if (this.showHistoryModal) {
            await this.loadFullHistoryRows();
        }
    }

    async refreshSla() {
        if (this.wiredSlaResult) {
            await refreshApex(this.wiredSlaResult);
        }
        // Refresca el estado de pausa/custodia para que la cuenta regresiva
        // refleje cambios de IsStopped sin requerir accion del usuario.
        if (this.wiredTeamResult) {
            await refreshApex(this.wiredTeamResult);
        }
        this.tickCustodyTimer();
    }

    async refreshTeamAndSla() {
        await Promise.all([
            this.wiredTeamResult ? refreshApex(this.wiredTeamResult) : Promise.resolve(),
            this.wiredSlaResult ? refreshApex(this.wiredSlaResult) : Promise.resolve(),
            this.wiredHistoryResult ? refreshApex(this.wiredHistoryResult) : Promise.resolve(),
            this.wiredTimelineResult ? refreshApex(this.wiredTimelineResult) : Promise.resolve()
        ]);
        this.tickCustodyTimer();
    }

    async openMisApoyosModal() {
        await this.loadSlaModal('apoyos', getMisApoyosForCurrentUser);
    }

    async openSlaMonitorModal() {
        await this.loadSlaModal('monitor', getSlaMonitorForCurrentUser);
    }

    async loadSlaModal(mode, apexMethod) {
        this.slaModalMode = mode;
        this.slaStatusFilter = 'all';
        this.slaSearchTerm = '';
        this.showSlaMonitorModal = true;
        this.slaMonitorLoading = true;
        this.slaMonitorAllRows = [];
        try {
            const rows = await apexMethod();
            this.slaMonitorAllRows = this.mapMonitorRows(rows);
        } catch (e) {
            this.toast(this.reduceErrors(e), 'error');
            this.showSlaMonitorModal = false;
        } finally {
            this.slaMonitorLoading = false;
        }
    }

    closeSlaMonitorModal() {
        this.showSlaMonitorModal = false;
    }

    mapMonitorRows(rows) {
        return (rows || []).map((r, i) => ({
            ...r,
            key: `mon-${i}`,
            badgeClass: `badge-sla badge-sla_${r.slaStatus || 'ok'}`,
            badgeText: this.slaStatusLabel(r.slaStatus)
        }));
    }

    slaStatusLabel(status) {
        const map = {
            violated: 'Infracción',
            danger: 'Infracci\u00F3n',
            warning: 'Riesgo',
            ok: 'OK'
        };
        return map[status] || '—';
    }

    handleMonitorRowClick(event) {
        const caseId = event.currentTarget.dataset.caseId;
        if (!caseId) {
            return;
        }
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: {
                recordId: caseId,
                objectApiName: 'Case',
                actionName: 'view'
            }
        });
        this.closeSlaMonitorModal();
    }

    openAddModal() {
        if (this.blockIfClosed()) {
            return;
        }
        this.newMemberUserId = null;
        this.newMemberRole = null;
        this.showAddModal = true;
    }

    closeAddModal() {
        this.showAddModal = false;
    }

    openEditModal(event) {
        this.openEditModalById(event.currentTarget.dataset.userId);
    }

    openEditModalById(userId) {
        const member = this.teamData.members.find((m) => m.userId === userId);
        if (!member?.canEdit) {
            return;
        }
        this.editRecordId = member.membershipRecordId;
        this.editMemberName = member.userName;
        this.editRole = member.role;
        this.editNotes = member.notes || '';
        this.showEditModal = true;
    }

    closeEditModal() {
        this.showEditModal = false;
    }

    handleUserPick(event) {
        this.newMemberUserId = event.detail?.recordId || null;
    }

    handleRoleChange(event) {
        this.newMemberRole = event.detail.value;
    }

    handleEditRoleChange(event) {
        this.editRole = event.detail.value;
    }

    handleEditNotesChange(event) {
        this.editNotes = event.detail.value;
    }

    async handleAddMember() {
        if (this.blockIfClosed()) {
            return;
        }
        if (!this.newMemberUserId) {
            this.toast('Seleccioná un usuario en el buscador.', 'error');
            return;
        }
        try {
            await addMember({
                caseId: this.recordId,
                userId: this.newMemberUserId,
                role: this.newMemberRole
            });
            this.showAddModal = false;
            await this.refreshTeam();
            await this.refreshSla();
            this.toast('Apoyo añadido', 'success');
        } catch (e) {
            this.toast(this.reduceErrors(e), 'error');
        }
    }

    async handleSaveEdit() {
        if (this.blockIfClosed()) {
            return;
        }
        try {
            await updateMember({
                recordId: this.editRecordId,
                role: this.editRole,
                notes: this.editNotes
            });
            this.showEditModal = false;
            await this.refreshTeam();
            this.toast('Apoyo actualizado', 'success');
        } catch (e) {
            this.toast(this.reduceErrors(e), 'error');
        }
    }

    async handleDeleteMember(event) {
        await this.deleteMemberById(event.currentTarget.dataset.userId);
    }

    async deleteMemberById(userId) {
        if (this.blockIfClosed()) {
            return;
        }
        const member = (this.teamData?.members ?? []).find((m) => m.userId === userId);
        if (!member || member.isOwner || !member.canEdit) {
            return;
        }

        const resolverName = this.ownerName || 'el resolutor del ticket';
        const message = member.isCurrentCustodian
            ? `${member.userName} tiene el ticket asignado ahora. Si lo quitás, la custodia volverá a ${resolverName}. ¿Continuar?`
            : `¿Quitar a ${member.userName} del equipo de este ticket?`;

        const confirmed = await LightningConfirm.open({
            message,
            variant: 'header',
            label: 'Quitar del equipo',
            theme: 'warning'
        });

        if (!confirmed) {
            return;
        }

        try {
            await deleteMember({ caseId: this.recordId, userId });
            await this.refreshTeam();
            this.toast('Apoyo eliminado', 'success');
        } catch (e) {
            this.toast(this.reduceErrors(e), 'error');
        }
    }

    openReleaseModal() {
        if (this.blockIfClosed()) {
            return;
        }
        this.custodyMode = 'release';
        this.custodyTargetUserId = null;
        this.custodyTargetName = this.currentCustodianName || 'el responsable actual';
        this.custodyReason = '';
        this.showCustodyModal = true;
    }

    openTransferModal(event) {
        if (this.blockIfClosed()) {
            return;
        }
        const userId = event.currentTarget.dataset.userId;
        const member = this.teamData.members.find((m) => m.userId === userId);
        this.custodyMode = 'transfer';
        this.custodyTargetUserId = userId;
        this.custodyTargetName = member?.userName || 'este consultor';
        this.custodyReason = '';
        this.showCustodyModal = true;
    }

    closeCustodyModal() {
        this.showCustodyModal = false;
    }

    handleCustodyReasonChange(event) {
        this.custodyReason = event.detail.value;
    }

    get custodyModalTitle() {
        return this.custodyMode === 'release'
            ? 'Devolver al resolutor'
            : `Pasar responsabilidad a ${this.custodyTargetName}`;
    }

    get custodyModalMessage() {
        return this.custodyMode === 'release'
            ? `La custodia volverá a ${this.ownerName || 'el resolutor del ticket'}.`
            : `El tramo actual se cerrará y ${this.custodyTargetName} pasará a ser responsable.`;
    }

    get custodyConfirmLabel() {
        return this.custodyMode === 'release' ? 'Devolver' : 'Confirmar';
    }

    async confirmCustodyAction() {
        if (this.blockIfClosed()) {
            this.showCustodyModal = false;
            return;
        }
        const motivo = this.custodyReason;
        try {
            if (this.custodyMode === 'release') {
                await releaseCustody({ caseId: this.recordId, motivo });
            } else {
                await transferCustody({
                    caseId: this.recordId,
                    newCustodianUserId: this.custodyTargetUserId,
                    motivo
                });
            }
            this.showCustodyModal = false;
            await this.refreshTeam();
            await this.refreshSla();
            this.toast(
                this.custodyMode === 'release'
                    ? 'Responsabilidad liberada'
                    : 'Responsable actualizado',
                'success'
            );
        } catch (e) {
            this.toast(this.reduceErrors(e), 'error');
        }
    }

    reduceErrors(error) {
        if (!error) {
            return 'Error desconocido';
        }
        if (Array.isArray(error.body)) {
            return error.body.map((e) => e.message).join(', ');
        }
        if (error.body?.message) {
            return error.body.message;
        }
        if (typeof error.body === 'string') {
            return error.body;
        }
        if (error.message) {
            return error.message;
        }
        return 'Error al procesar la solicitud';
    }

    toast(message, variant) {
        this.dispatchEvent(
            new ShowToastEvent({
                title: variant === 'error' ? 'Error' : 'Listo',
                message,
                variant,
                mode: variant === 'error' ? 'sticky' : 'dismissable'
            })
        );
    }
}
