import { LightningElement, api } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import getSlaMonitorForCurrentUser from '@salesforce/apex/EquipoResolutoresController.getSlaMonitorForCurrentUser';
import USER_ID from '@salesforce/user/Id';
import { createEquipoRealtimeSubscription } from 'c/equipoResolutoresRealtime';

const SORT_OPTIONS = [
    { label: 'Mayor riesgo SLA', value: 'sla' },
    { label: 'M\u00E1s recientes', value: 'newest' },
    { label: 'M\u00E1s antiguos', value: 'oldest' },
    { label: 'Cliente A-Z', value: 'account' }
];

const QUICK_FILTERS = [
    { key: 'all', label: 'Todos', icon: 'utility:rows' },
    { key: 'incidente', label: 'Incidentes', icon: 'utility:warning' },
    { key: 'requerimiento', label: 'Requerimientos', icon: 'utility:case' },
    { key: 'criticos', label: 'Cr\u00EDticos', icon: 'utility:priority' },
    { key: 'vence_hoy', label: 'Vence hoy', icon: 'utility:clock' }
];

const TICK_MS = 1000;
const PAGE_SIZE = 8;
/** Sondeo de respaldo (Platform Events cubren cambios entre usuarios). */
const TEAM_POLL_MS = 120000;

const PRIORITY_ES = {
    high: 'Alta',
    'very high': 'Muy alta',
    critical: 'Cr\u00EDtica',
    medium: 'Media',
    med: 'Media',
    low: 'Baja',
    alta: 'Alta',
    'muy alta': 'Muy alta',
    'muy alta prioridad': 'Muy alta',
    media: 'Media',
    baja: 'Baja',
    critica: 'Cr\u00EDtica',
    'crítica': 'Cr\u00EDtica'
};

export default class EquipoResolutoresHome extends NavigationMixin(LightningElement) {
    @api autoRefreshMinutes = 5;

    slaMonitorAllRows = [];
    slaStatusFilter = 'all';
    quickFilter = 'all';
    slaSearchTerm = '';
    sortBy = 'sla';
    density = 'comfortable';
    loading = true;
    lastRefreshAt = null;
    nowTick = Date.now();
    currentPage = 1;

    showPopup = false;
    popupCaseId;
    popupCaseNumber;

    showHistoryModal = false;
    historyCaseId;
    historyCaseNumber;

    refreshTimer;
    clockTimer;
    teamPollTimer;
    _realtimeSubscription;

    sortOptions = SORT_OPTIONS;
    quickFilterDefs = QUICK_FILTERS;

    connectedCallback() {
        this.loadData();
        this.setupAutoRefresh();
        this.clockTimer = setInterval(() => {
            this.nowTick = Date.now();
        }, TICK_MS);

        // Refresco instantáneo al recuperar el foco (cambios de otros usuarios).
        this._onVisibility = () => {
            if (document.visibilityState === 'visible') {
                this.refreshOnFocus();
            }
        };
        this._onWindowFocus = () => this.refreshOnFocus();
        document.addEventListener('visibilitychange', this._onVisibility);
        window.addEventListener('focus', this._onWindowFocus);

        this.teamPollTimer = setInterval(() => {
            if (!this.showPopup) {
                this.loadData();
            }
        }, TEAM_POLL_MS);

        this._realtimeSubscription = createEquipoRealtimeSubscription({
            userId: USER_ID,
            onNotify: () => {
                if (!this.showPopup) {
                    this.loadData();
                }
            }
        });
    }

    refreshOnFocus() {
        const now = Date.now();
        if (this._lastFocusRefreshMs && now - this._lastFocusRefreshMs < 4000) {
            return;
        }
        this._lastFocusRefreshMs = now;
        if (!this.showPopup) {
            this.loadData();
        }
    }

    disconnectedCallback() {
        this.clearAutoRefresh();
        if (this.teamPollTimer) {
            clearInterval(this.teamPollTimer);
            this.teamPollTimer = null;
        }
        if (this.clockTimer) {
            clearInterval(this.clockTimer);
            this.clockTimer = null;
        }
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

    setupAutoRefresh() {
        this.clearAutoRefresh();
        const min = Number(this.autoRefreshMinutes);
        if (min && min > 0) {
            this.refreshTimer = setInterval(() => {
                if (!this.showPopup) {
                    this.loadData();
                }
            }, min * 60 * 1000);
        }
    }

    clearAutoRefresh() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    get hasData() {
        return this.slaMonitorAllRows.length > 0;
    }

    get hasFilteredRows() {
        return this.filteredSortedRows.length > 0;
    }

    get totalCount() {
        return this.slaMonitorAllRows.length;
    }

    get criticalSlaCount() {
        return this.slaMonitorAllRows.filter((r) => r.slaStatus === 'violated').length;
    }

    get statCells() {
        const rows = this.slaMonitorAllRows;
        const count = (s) => rows.filter((r) => r.slaStatus === s).length;
        const isOn = (v) => this.slaStatusFilter === v;
        const cell = (key, n, label, value, tone, icon) => ({
            key,
            count: n,
            label,
            value,
            icon,
            cellClass: isOn(value)
                ? `stat-cell stat-cell_${tone} stat-cell_on`
                : `stat-cell stat-cell_${tone}`
        });
        return [
            cell('crit', count('violated'), 'Infracci\u00F3n', 'violated', 'crit', 'utility:warning'),
            cell('warn', count('warning'), 'En riesgo', 'warning', 'warn', 'utility:clock'),
            cell('ok', count('ok'), 'OK', 'ok', 'ok', 'utility:success'),
            cell('all', rows.length, 'Total', 'all', 'all', 'utility:list')
        ];
    }

    get quickFilterPills() {
        return this.quickFilterDefs.map((f) => ({
            ...f,
            pillClass:
                this.quickFilter === f.key
                    ? 'qf-pill qf-pill_active'
                    : 'qf-pill'
        }));
    }

    get summaryText() {
        return 'Visi\u00F3n en tiempo real del cumplimiento de acuerdos de servicio';
    }

    /** Filas filtradas y ordenadas (sin paginar ni decorar en vivo). */
    get filteredSortedRows() {
        return this.applySort(this.applyFilters(this.slaMonitorAllRows));
    }

    get totalPages() {
        return Math.max(1, Math.ceil(this.filteredSortedRows.length / PAGE_SIZE));
    }

    get safePage() {
        return Math.min(Math.max(1, this.currentPage), this.totalPages);
    }

    get pageInfoLabel() {
        const total = this.filteredSortedRows.length;
        if (total === 0) return 'Sin tickets';
        const startIdx = (this.safePage - 1) * PAGE_SIZE;
        const from = startIdx + 1;
        const to = Math.min(startIdx + PAGE_SIZE, total);
        return `Mostrando ${from} a ${to} de ${total} tickets`;
    }

    get showPagination() {
        return this.totalPages > 1;
    }

    get pageNumbers() {
        const total = this.totalPages;
        const cur = this.safePage;
        const nums = [];
        const push = (n, isGap) =>
            nums.push({
                key: isGap ? `gap-${nums.length}` : `p-${n}`,
                num: n,
                isGap: !!isGap,
                btnClass: n === cur ? 'pg-num pg-num_active' : 'pg-num'
            });
        if (total <= 6) {
            for (let i = 1; i <= total; i++) push(i, false);
            return nums;
        }
        push(1, false);
        if (cur > 3) push(null, true);
        const start = Math.max(2, cur - 1);
        const end = Math.min(total - 1, cur + 1);
        for (let i = start; i <= end; i++) push(i, false);
        if (cur < total - 2) push(null, true);
        push(total, false);
        return nums;
    }

    get prevDisabled() {
        return this.safePage <= 1;
    }

    get nextDisabled() {
        return this.safePage >= this.totalPages;
    }

    get lastRefreshLabel() {
        if (!this.lastRefreshAt) return '';
        const diffMin = Math.max(0, Math.round((this.nowTick - this.lastRefreshAt) / 60000));
        if (diffMin < 1) return 'reci\u00E9n';
        if (diffMin === 1) return 'hace 1 min';
        if (diffMin < 60) return `hace ${diffMin} min`;
        const h = Math.round(diffMin / 60);
        return `hace ${h} h`;
    }

    get tableClass() {
        return this.density === 'compact'
            ? 'monitor-table density-compact'
            : 'monitor-table';
    }

    get densityToggleIcon() {
        return this.density === 'compact' ? 'utility:expand_alt' : 'utility:contract_alt';
    }

    get densityToggleTitle() {
        return this.density === 'compact' ? 'Vista c\u00F3moda' : 'Vista compacta';
    }

    get displayedRows() {
        const startIdx = (this.safePage - 1) * PAGE_SIZE;
        return this.filteredSortedRows
            .slice(startIdx, startIdx + PAGE_SIZE)
            .map((r) => this.decorateLive(r));
    }

    decorateLive(row) {
        const tick = this.nowTick || Date.now();
        const live = this.computeCountdown(row, tick);
        const prog = this.computeSlaProgress(row, tick);
        const wrapClass =
            live.kind === 'violated'
                ? 'sla-countdown-wrap sla-countdown-wrap_violated'
                : 'sla-countdown-wrap';
        return {
            ...row,
            countdownLabel: live.label,
            countdownClass: `sla-countdown sla-countdown_${live.kind}`,
            countdownWrapClass: wrapClass,
            slaBarClass: `sla-bar ${prog.barClass}`,
            slaBarStyle: `width:${prog.pct}%;`,
            isPaused: row.isPaused === true
        };
    }

    /** Referencia de tiempo: congelada en el instante de pausa si el SLA está detenido. */
    countdownRef(row, nowMs) {
        if (row.isPaused && row.pauseStartMs) {
            return row.pauseStartMs;
        }
        return nowMs;
    }

    computeCountdown(row, nowMs) {
        const targetMs = row.targetDate ? new Date(row.targetDate).getTime() : null;
        if (!targetMs) {
            return { label: 'Sin hito activo', kind: 'none' };
        }
        const ref = this.countdownRef(row, nowMs);
        const diffMs = targetMs - ref;
        if (row.slaStatus === 'violated' || diffMs <= 0) {
            const base = `Infracci\u00F3n hace ${this.formatElapsed(Math.abs(diffMs))}`;
            return {
                label: row.isPaused ? `Pausado · ${base}` : base,
                kind: row.isPaused ? 'paused' : 'violated'
            };
        }
        const base = `Vence en ${this.formatElapsed(diffMs)}`;
        return {
            label: row.isPaused ? `Pausado · ${base}` : base,
            kind: row.isPaused
                ? 'paused'
                : (row.slaStatus === 'warning' ? 'warning' : 'ok')
        };
    }

    computeSlaProgress(row, nowMs) {
        const targetMs = row.targetDate ? new Date(row.targetDate).getTime() : null;
        if (!targetMs) {
            return { pct: 0, barClass: 'sla-bar_none' };
        }
        const diffMs = targetMs - this.countdownRef(row, nowMs);
        if (diffMs <= 0 || row.slaStatus === 'violated' || row.slaStatus === 'danger') {
            return { pct: 100, barClass: 'sla-bar_violated' };
        }
        const hours = diffMs / 3600000;
        let pct = 15;
        if (hours <= 1) pct = 92;
        else if (hours <= 8) pct = 78;
        else if (hours <= 24) pct = 58;
        else if (hours <= 72) pct = 38;
        const barClass = row.slaStatus === 'warning' ? 'sla-bar_warning' : 'sla-bar_ok';
        return { pct, barClass };
    }

    formatElapsed(ms) {
        const totalSec = Math.max(0, Math.floor(ms / 1000));
        const d = Math.floor(totalSec / 86400);
        const h = Math.floor((totalSec % 86400) / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const pad = (n) => String(n).padStart(2, '0');
        if (d > 0) {
            return `${d}d ${h}h ${pad(m)}m ${pad(s)}s`;
        }
        if (h > 0) {
            return `${h}h ${pad(m)}m ${pad(s)}s`;
        }
        return `${m}m ${pad(s)}s`;
    }

    async loadData() {
        this.loading = true;
        try {
            const rows = await getSlaMonitorForCurrentUser();
            this.slaMonitorAllRows = this.mapMonitorRows(rows);
            this.lastRefreshAt = Date.now();
            this.nowTick = this.lastRefreshAt;
            this.currentPage = 1;
        } catch (e) {
            this.slaMonitorAllRows = [];
        } finally {
            this.loading = false;
        }
    }

    handleQuickFilterClick(event) {
        const value = event.currentTarget.dataset.value;
        if (!value) return;
        this.quickFilter = this.quickFilter === value && value !== 'all' ? 'all' : value;
        this.currentPage = 1;
    }

    handleStatClick(event) {
        const value = event.currentTarget.dataset.value;
        if (!value) return;
        this.slaStatusFilter =
            this.slaStatusFilter === value && value !== 'all' ? 'all' : value;
        this.currentPage = 1;
    }

    handleSlaSearchChange(event) {
        this.slaSearchTerm = event.detail.value;
        this.currentPage = 1;
    }

    handleSortChange(event) {
        this.sortBy = event.detail.value;
        this.currentPage = 1;
    }

    handlePrevPage() {
        if (this.safePage > 1) {
            this.currentPage = this.safePage - 1;
        }
    }

    handleNextPage() {
        if (this.safePage < this.totalPages) {
            this.currentPage = this.safePage + 1;
        }
    }

    handlePageClick(event) {
        const num = Number(event.currentTarget.dataset.page);
        if (num) {
            this.currentPage = num;
        }
    }

    handleDensityToggle() {
        this.density = this.density === 'compact' ? 'comfortable' : 'compact';
    }

    handleRefresh() {
        this.loadData();
    }

    handleOpenHistory(event) {
        event.stopPropagation();
        const caseId = event.currentTarget.dataset.caseId;
        const caseNumber = event.currentTarget.dataset.caseNumber;
        if (!caseId) return;
        this.historyCaseId = caseId;
        this.historyCaseNumber = caseNumber;
        this.showHistoryModal = true;
    }

    handleHistoryClose() {
        this.showHistoryModal = false;
        this.historyCaseId = null;
        this.historyCaseNumber = null;
    }

    handleOpenTicket(event) {
        event.stopPropagation();
        this.openTicketById(event.currentTarget.dataset.caseId);
    }

    openTicketById(caseId) {
        if (!caseId) return;
        this[NavigationMixin.GenerateUrl]({
            type: 'standard__recordPage',
            attributes: {
                recordId: caseId,
                objectApiName: 'Case',
                actionName: 'view'
            }
        }).then((url) => {
            window.open(url, '_blank');
        });
    }

    handleRowMenuSelect(event) {
        const action = event.detail.value;
        const caseId = event.currentTarget.dataset.caseId;
        const caseNumber = event.currentTarget.dataset.caseNumber;
        if (action === 'open') {
            this.openTicketById(caseId);
        } else if (action === 'history') {
            if (!caseId) return;
            this.historyCaseId = caseId;
            this.historyCaseNumber = caseNumber;
            this.showHistoryModal = true;
        } else if (action === 'attend') {
            if (!caseId) return;
            this.popupCaseId = caseId;
            this.popupCaseNumber = caseNumber;
            this.showPopup = true;
        }
    }

    handleQuickAction(event) {
        event.stopPropagation();
        const caseId = event.currentTarget.dataset.caseId;
        const caseNumber = event.currentTarget.dataset.caseNumber;
        if (!caseId) return;
        this.popupCaseId = caseId;
        this.popupCaseNumber = caseNumber;
        this.showPopup = true;
    }

    handlePopupClose() {
        this.showPopup = false;
        this.popupCaseId = null;
        this.popupCaseNumber = null;
    }

    handleActionDone() {
        this.loadData();
    }

    applyFilters(rows) {
        let list = rows || [];

        if (this.quickFilter === 'incidente') {
            list = list.filter((r) => this.matchesRecordType(r.recordTypeName, 'incid'));
        } else if (this.quickFilter === 'requerimiento') {
            list = list.filter((r) => this.matchesRecordType(r.recordTypeName, 'requer'));
        } else if (this.quickFilter === 'criticos') {
            list = list.filter((r) => r.isCriticalPriority);
        } else if (this.quickFilter === 'vence_hoy') {
            list = list.filter((r) => r.venceHoy);
        }

        if (this.slaStatusFilter === 'violated' || this.slaStatusFilter === 'crit') {
            list = list.filter((r) => r.slaStatus === 'violated');
        } else if (this.slaStatusFilter !== 'all') {
            list = list.filter((r) => r.slaStatus === this.slaStatusFilter);
        }

        const q = (this.slaSearchTerm || '').trim().toLowerCase();
        if (q) {
            list = list.filter(
                (r) =>
                    (r.caseNumber && r.caseNumber.toLowerCase().includes(q)) ||
                    (r.subject && r.subject.toLowerCase().includes(q)) ||
                    (r.milestoneName && r.milestoneName.toLowerCase().includes(q)) ||
                    (r.responsibleName && r.responsibleName.toLowerCase().includes(q)) ||
                    (r.accountName && r.accountName.toLowerCase().includes(q)) ||
                    (r.caseStatus && r.caseStatus.toLowerCase().includes(q))
            );
        }
        return list;
    }

    applySort(list) {
        const arr = [...list];
        if (this.sortBy === 'newest') {
            arr.sort((a, b) => (b._createdMs || 0) - (a._createdMs || 0));
        } else if (this.sortBy === 'oldest') {
            arr.sort((a, b) => (a._createdMs || 0) - (b._createdMs || 0));
        } else if (this.sortBy === 'account') {
            arr.sort((a, b) =>
                (a.accountName || '').localeCompare(b.accountName || '', 'es')
            );
        } else {
            arr.sort((a, b) => {
                const so = (a.sortOrder ?? 99) - (b.sortOrder ?? 99);
                if (so !== 0) return so;
                return (a._minutesRemaining ?? 0) - (b._minutesRemaining ?? 0);
            });
        }
        return arr;
    }

    mapMonitorRows(rows) {
        return (rows || []).map((r, i) => {
            const isApoyo = r.isApoyoEquipo === true;
            const responsibleDisplay = r.isMyTurn
                ? 'Mi turno'
                : r.responsibleName || '\u2014';
            let rowClass = `monitor-row monitor-row_${r.slaStatus || 'ok'}`;
            if (isApoyo) {
                rowClass += ' monitor-row_apoyo';
            }
            const targetMs = r.targetDate ? new Date(r.targetDate).getTime() : null;
            const venceHoy = this.isDueToday(targetMs);
            return {
                ...r,
                key: `home-${i}`,
                isApoyoEquipo: isApoyo,
                recordTypeName: r.recordTypeName || '',
                badgeClass: `badge-sla badge-sla_${r.slaStatus || 'ok'}`,
                rowClass,
                badgeText: this.slaStatusLabel(r.slaStatus, targetMs),
                priorityClass: this.priorityClass(r.priority),
                priorityLabel: this.priorityLabelEs(r.priority),
                isCriticalPriority: this.isCriticalPriority(r.priority),
                venceHoy,
                responsibleDisplay,
                responsibleClass: r.isMyTurn ? 'responsible-mine' : 'responsible-other',
                subjectDisplay: r.subject || '\u2014',
                accountDisplay: r.accountName || '\u2014',
                statusDisplay: r.caseStatus || '\u2014',
                responsibleLine: r.isMyTurn
                    ? null
                    : r.responsibleName || null,
                _createdMs: r.createdDate ? new Date(r.createdDate).getTime() : 0,
                _minutesRemaining: r.minutesRemaining ?? 0
            };
        });
    }

    /** Coincidencia flexible de tipo de registro (DeveloperName en es/plural/variantes). */
    matchesRecordType(recordTypeName, prefix) {
        return (recordTypeName || '').toLowerCase().includes(prefix);
    }

    isDueToday(targetMs) {
        if (!targetMs) return false;
        const now = new Date(this.nowTick || Date.now());
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        const end = new Date(now);
        end.setHours(23, 59, 59, 999);
        return targetMs >= start.getTime() && targetMs <= end.getTime();
    }

    isCriticalPriority(priority) {
        const p = (priority || '').toLowerCase().trim();
        return (
            p.includes('very high')
            || p.includes('muy alta')
            || p.includes('crít')
            || p.includes('crit')
            || p === '1'
        );
    }

    priorityLabelEs(priority) {
        const raw = (priority || '').trim();
        if (!raw) return '\u2014';
        const key = raw.toLowerCase();
        if (PRIORITY_ES[key]) return PRIORITY_ES[key];
        if (this.isCriticalPriority(raw)) return 'Muy alta';
        if (key.includes('high') || key.includes('alta')) return 'Alta';
        if (key.includes('med')) return 'Media';
        if (key.includes('low') || key.includes('baja')) return 'Baja';
        return raw;
    }

    slaStatusLabel(status, targetMs) {
        if (!targetMs) return 'Sin hito';
        const map = {
            violated: 'Infracci\u00F3n',
            danger: 'Infracci\u00F3n',
            warning: 'Riesgo',
            ok: 'OK'
        };
        return map[status] || 'OK';
    }

    priorityClass(priority) {
        if (this.isCriticalPriority(priority)) return 'pri-pill pri-crit';
        const p = (priority || '').toLowerCase();
        if (p.includes('alta') || p.includes('high')) return 'pri-pill pri-high';
        if (p.includes('media') || p.includes('med')) return 'pri-pill pri-med';
        if (p.includes('baja') || p.includes('low')) return 'pri-pill pri-low';
        return 'pri-pill pri-none';
    }
}
