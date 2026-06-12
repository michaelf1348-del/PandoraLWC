import { LightningElement, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getBacklogData from '@salesforce/apex/BacklogKaufmannController.getBacklogData';
import updateBacklogRecords from '@salesforce/apex/BacklogKaufmannController.updateBacklogRecords';
import recalcularIndicadores from '@salesforce/apex/BacklogKaufmannController.recalcularIndicadores';

const EDITABLE_FIELDS = new Set([
    'Proyecto_Principal__c',
    'Descripci_n_breve__c',
    'Tipo_de_Tarea__c',
    'Consultor_Seidor__c',
    'HH_Total__c',
    'Fecha_de_Inicio__c',
    'Fecha_Plan_QA__c'
]);

// Column definition for the custom HTML table.
// Widths in % so table-layout:fixed fills 100% of the container (no right gap).
const COLUMNS = [
    { key: 'rownum',     label: '#',                  width: '40px', sortable: false },
    { key: 'idRef',      label: 'ID Ref',             width: '7%',   sortable: true,  field: 'idRef' },
    { key: 'proyecto',   label: 'Proyecto',           width: '7%',   sortable: true,  field: 'Proyecto_Principal__c' },
    { key: 'desc',       label: 'Descripción',        width: '21%',  sortable: true,  field: 'Descripci_n_breve__c' },
    { key: 'tipo',       label: 'Tipo de tarea',      width: '9%',   sortable: true,  field: 'Tipo_de_Tarea__c' },
    { key: 'estado',     label: 'Estado',             width: '8%',   sortable: true,  field: 'Estado__c' },
    { key: 'consK',      label: 'Consultor Kaufmann', width: '10%',  sortable: true,  field: 'consultorKaufmann' },
    { key: 'consS',      label: 'Consultor Seidor',   width: '9%',   sortable: true,  field: 'Consultor_Seidor__c' },
    { key: 'hh',         label: 'HH',                 width: '5%',   sortable: true,  field: 'HH_Total__c' },
    { key: 'fini',       label: 'Fecha Inicio',       width: '8%',   sortable: true,  field: 'Fecha_de_Inicio__c' },
    { key: 'fqa',        label: 'Fecha Plan QA',      width: '8%',   sortable: true,  field: 'Fecha_Plan_QA__c' },
    { key: 'asign',      label: '% Asig.',            width: '7%',   sortable: true,  field: 'Asignaci_n_a_la_tarea__c' },
    { key: 'avance',     label: '% Avance',           width: '8%',   sortable: true,  field: 'Avance_Real__c' }
];

export default class BacklogKaufmann extends LightningElement {
    @track allRows = [];
    @track displayRows = [];
    @track draftMap = {};
    @track summary = { totalRecords: 0, enCurso: 0, pendiente: 0, totalHoras: 0 };
    @track resumenEstados = [];

    searchTerm = '';
    tipoTareaFilter = '';
    estadoFilter = '';
    consultorFilter = '';

    tipoTareaOptions = [{ label: 'Todos los tipos', value: '' }];
    estadoOptions = [{ label: 'Todos los estados', value: '' }];
    consultorOptions = [{ label: 'Todos', value: '' }];

    activeTab = 'tabla';
    sortField = 'Fecha_Plan_QA__c';
    sortDirection = 'asc';
    pageSize = 25;
    currentPage = 1;

    isLoading = true;
    isSaving = false;
    isRecalculating = false;
    errorMessage;
    lastUpdatedLabel = '';

    connectedCallback() {
        this.loadData();
    }

    /* ── Tabs ── */
    get isTablaActive()  { return this.activeTab === 'tabla'; }
    get isResumenActive(){ return this.activeTab === 'resumen'; }
    get tablaTabClass()  { return `cc-tab${this.isTablaActive ? ' cc-tab--active' : ''}`; }
    get resumenTabClass(){ return `cc-tab${this.isResumenActive ? ' cc-tab--active' : ''}`; }

    /* ── Counts ── */
    get filteredRows()  { return this.getFilteredRows(); }
    get filteredCount() { return this.filteredRows.length; }
    get hasRows()       { return this.filteredCount > 0; }

    /* ── KPIs ── */
    get totalHorasLabel() {
        const h = this.summary?.totalHoras ?? 0;
        return h.toLocaleString('es-CL', { maximumFractionDigits: 1 });
    }
    get avancePromedio() {
        if (!this.allRows.length) return 0;
        const sum = this.allRows.reduce((a, r) => a + (this.num(r.Avance_Real__c)), 0);
        return Math.round((sum / this.allRows.length) * 10) / 10;
    }
    get avanceRingStyle() { return `--progress: ${Math.min(this.avancePromedio, 100)}%`; }
    get enCursoPct() {
        const t = this.summary?.totalRecords || 1;
        return Math.round(((this.summary?.enCurso ?? 0) / t) * 100);
    }
    get pendientePct() {
        const t = this.summary?.totalRecords || 1;
        return Math.round(((this.summary?.pendiente ?? 0) / t) * 100);
    }
    get enCursoBarStyle()  { return `width:${this.enCursoPct}%`; }
    get pendienteBarStyle(){ return `width:${this.pendientePct}%`; }

    get isBusy() { return this.isLoading || this.isSaving || this.isRecalculating; }

    /* ── Filters ── */
    get hasActiveFilters() {
        return !!(this.searchTerm || this.tipoTareaFilter || this.estadoFilter || this.consultorFilter);
    }
    get activeFilterChips() {
        const chips = [];
        if (this.searchTerm)     chips.push({ key: 'search',   label: `Búsqueda: ${this.searchTerm}`,       field: 'search' });
        if (this.tipoTareaFilter)chips.push({ key: 'tipo',     label: `Tipo: ${this.tipoTareaFilter}`,       field: 'tipo' });
        if (this.estadoFilter)   chips.push({ key: 'estado',   label: `Estado: ${this.estadoFilter}`,        field: 'estado' });
        if (this.consultorFilter)chips.push({ key: 'consultor',label: `Consultor: ${this.consultorFilter}`,  field: 'consultor' });
        return chips;
    }
    get tipoEditOptions()   { return this.tipoTareaOptions.filter(o => o.value); }

    /* ── Table columns (header + colgroup) ── */
    get tableColumns() {
        return COLUMNS.map(c => ({
            ...c,
            colStyle: `width:${c.width}`,
            thClass: c.sortable ? 'bk-th bk-th--sortable' : 'bk-th',
            indicator: (c.field && c.field === this.sortField)
                ? (this.sortDirection === 'asc' ? '▲' : '▼')
                : ''
        }));
    }

    get sortOrderLabel() {
        const col = COLUMNS.find(c => c.field === this.sortField);
        if (!col) return '';
        return `${col.label} (${this.sortDirection === 'asc' ? 'asc' : 'desc'})`;
    }

    /* ── Pagination ── */
    get totalPages() { return Math.max(1, Math.ceil(this.filteredCount / this.pageSize)); }
    get paginationLabel() {
        if (!this.filteredCount) return 'Sin resultados';
        const start = (this.currentPage - 1) * this.pageSize + 1;
        const end   = Math.min(this.currentPage * this.pageSize, this.filteredCount);
        return `Mostrando ${start}–${end} de ${this.filteredCount.toLocaleString('es-CL')} demandas`;
    }
    get isFirstPage()  { return this.currentPage <= 1; }
    get isLastPage()   { return this.currentPage >= this.totalPages; }
    get prevDisabled() { return this.isFirstPage || this.isBusy; }
    get nextDisabled() { return this.isLastPage  || this.isBusy; }

    get pageNumbers() {
        const total = this.totalPages;
        const cur   = this.currentPage;
        const items = [];
        const push = n => items.push({
            key: String(n), num: n, label: String(n), isEllipsis: false,
            btnClass: n === cur ? 'cc__pag-btn cc__pag-btn--active' : 'cc__pag-btn'
        });
        const ellipsis = k => items.push({ key: k, num: null, label: '...', isEllipsis: true, btnClass: '' });
        if (total <= 7) { for (let i = 1; i <= total; i++) push(i); return items; }
        push(1);
        if (cur > 3) ellipsis('e1');
        for (let i = Math.max(2, cur - 1); i <= Math.min(total - 1, cur + 1); i++) push(i);
        if (cur < total - 2) ellipsis('e2');
        push(total);
        return items;
    }

    /* ── Drafts ── */
    get draftCount() { return Object.keys(this.draftMap).length; }
    get hasDrafts()  { return this.draftCount > 0; }

    /* ── Data ── */
    async loadData() {
        this.isLoading = true;
        this.errorMessage = undefined;
        try {
            const result = await getBacklogData({
                searchTerm:      this.searchTerm,
                tipoTareaFilter: this.tipoTareaFilter,
                estadoFilter:    this.estadoFilter
            });
            this.summary  = result.summary ?? this.summary;
            this.allRows  = (result.rows ?? []).map(r => this.mapRow(r));
            this.draftMap = {};
            this.buildFilterOptions(result.tipoTareaOptions, result.estadoOptions);
            this.buildResumenEstados();
            this.currentPage = 1;
            this.refreshDisplayRows();
            this.lastUpdatedLabel = this.formatNow();
        } catch (error) {
            this.errorMessage = this.reduceError(error);
            this.allRows = [];
            this.displayRows = [];
        } finally {
            this.isLoading = false;
        }
    }

    mapRow(r) {
        return {
            id:                         r.id,
            idRef:                      r.idRef,
            recordUrl:                  r.recordUrl,
            consultorKaufmann:          r.consultorKaufmann,
            Proyecto_Principal__c:      r.proyecto,
            Descripci_n_breve__c:       r.descripcion,
            Tipo_de_Tarea__c:           r.tipoTarea,
            Estado__c:                  r.estado,
            Consultor_Seidor__c:        r.consultorSeidor,
            HH_Total__c:                r.hhTotal,
            Fecha_de_Inicio__c:         r.fechaInicio,
            Fecha_Plan_QA__c:           r.fechaPlanQa,
            Asignaci_n_a_la_tarea__c:   r.asignacionTarea,
            Avance_Real__c:             r.avanceReal
        };
    }

    buildFilterOptions(tipos, estados) {
        this.tipoTareaOptions = [
            { label: 'Todos los tipos', value: '' },
            ...(tipos ?? []).map(v => ({ label: v, value: v }))
        ];
        this.estadoOptions = [
            { label: 'Todos los estados', value: '' },
            ...(estados ?? []).map(v => ({ label: v, value: v }))
        ];
        const set = new Set();
        this.allRows.forEach(r => { if (r.Consultor_Seidor__c) set.add(r.Consultor_Seidor__c); });
        this.consultorOptions = [
            { label: 'Todos', value: '' },
            ...[...set].sort().map(v => ({ label: v, value: v }))
        ];
    }

    buildResumenEstados() {
        const counts = {};
        this.allRows.forEach(r => {
            const k = r.Estado__c || 'Sin estado';
            counts[k] = (counts[k] || 0) + 1;
        });
        const total = this.allRows.length || 1;
        this.resumenEstados = Object.entries(counts)
            .map(([estado, count]) => ({
                key: estado, estado, count,
                pct:      Math.round((count / total) * 100),
                barStyle: `width:${(count / total) * 100}%`,
                badgeClass: this.resumenBadgeClass(estado)
            }))
            .sort((a, b) => b.count - a.count);
    }

    badgeBase(e) {
        const s = (e || '').toLowerCase();
        if (s.includes('curso'))                              return 'curso';
        if (s.includes('pendiente') || s.includes('inicio'))  return 'pendiente';
        if (s.includes('bloquea') || s.includes('cancel') ||
            s.includes('rechaz'))                             return 'bloqueado';
        if (s.includes('complet') || s.includes('cerrad') ||
            s.includes('finaliz'))                            return 'completado';
        return 'default';
    }
    tableBadgeClass(e)   { return `bk-badge bk-badge--${this.badgeBase(e)}`; }
    resumenBadgeClass(e) { return `rs-badge rs-badge--${this.badgeBase(e)}`; }

    /* ── Filtering / sorting / paging ── */
    getFilteredRows() {
        let rows = this.allRows;
        if (this.consultorFilter) rows = rows.filter(r => r.Consultor_Seidor__c === this.consultorFilter);
        return this.sortRows([...rows]);
    }

    sortRows(rows) {
        const f   = this.sortField;
        const dir = this.sortDirection === 'asc' ? 1 : -1;
        return rows.sort((a, b) => {
            const va = a[f], vb = b[f];
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
            return String(va).localeCompare(String(vb), 'es') * dir;
        });
    }

    refreshDisplayRows() {
        const filtered = this.getFilteredRows();
        const start    = (this.currentPage - 1) * this.pageSize;
        const pageRows = filtered.slice(start, start + this.pageSize);
        this.displayRows = pageRows.map((r, i) => this.buildDisplayRow(r, start + i + 1));
    }

    buildDisplayRow(r, rowNum) {
        const draft  = this.draftMap[r.id] || {};
        const merged = { ...r, ...draft };
        const asign  = this.num(merged.Asignaci_n_a_la_tarea__c);
        const avance = this.num(merged.Avance_Real__c);
        return {
            id:                merged.id,
            rowNum,
            idRef:             merged.idRef,
            recordUrl:         merged.recordUrl,
            consultorKaufmann: merged.consultorKaufmann,
            proyecto:          merged.Proyecto_Principal__c,
            descripcion:       merged.Descripci_n_breve__c,
            tipoTarea:         merged.Tipo_de_Tarea__c,
            tipoOptions:       this.tipoEditOptions.map(o => ({
                                   value: o.value,
                                   label: o.label,
                                   selectedFlag: o.value === merged.Tipo_de_Tarea__c
                               })),
            estado:            merged.Estado__c,
            estadoBadgeClass:  this.tableBadgeClass(merged.Estado__c),
            consultorSeidor:   merged.Consultor_Seidor__c,
            hhTotal:           merged.HH_Total__c,
            fechaInicioVal:    this.toDateInput(merged.Fecha_de_Inicio__c),
            fechaPlanVal:      this.toDateInput(merged.Fecha_Plan_QA__c),
            asignLabel:        `${Math.round(asign * 10) / 10}%`,
            asignBarStyle:     this.barStyle(asign),
            avanceLabel:       `${Math.round(avance * 10) / 10}%`,
            avanceBarStyle:    this.barStyle(avance),
            rowClass:          draft && Object.keys(draft).length ? 'bk-row bk-row--dirty' : 'bk-row'
        };
    }

    /* ── Helpers ── */
    num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

    toDateInput(v) {
        if (!v) return '';
        const s = String(v);
        return s.length >= 10 ? s.slice(0, 10) : s;
    }

    barStyle(pct) {
        const p = Math.min(Math.max(pct, 0), 100);
        let color;
        if (p >= 80)      color = '#16a34a';
        else if (p >= 40) color = '#f59e0b';
        else if (p > 0)   color = '#e53935';
        else              color = '#d1d5db';
        return `width:${p}%;background-color:${color};`;
    }

    formatNow() {
        return new Date().toLocaleString('es-CL', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    }

    /* ── Filter handlers ── */
    handleSearchChange(event)   { this.searchTerm = event.target.value; }
    handleSearchKeyUp(event)    { if (event.key === 'Enter') this.applyAndLoad(); }
    handleTipoTareaChange(event){ this.tipoTareaFilter = event.detail.value; this.applyAndLoad(); }
    handleEstadoChange(event)   { this.estadoFilter    = event.detail.value; this.applyAndLoad(); }
    handleConsultorChange(event){ this.consultorFilter = event.detail.value; this.currentPage = 1; this.refreshDisplayRows(); }
    handleApplyFilters()        { this.applyAndLoad(); }
    applyAndLoad()              { this.currentPage = 1; this.loadData(); }

    handleRemoveChip(event) {
        const f = event.currentTarget.dataset.field;
        if (f === 'search')   this.searchTerm = '';
        if (f === 'tipo')     this.tipoTareaFilter = '';
        if (f === 'estado')   this.estadoFilter = '';
        if (f === 'consultor')this.consultorFilter = '';
        this.applyAndLoad();
    }
    handleClearFilters() {
        this.searchTerm = this.tipoTareaFilter = this.estadoFilter = this.consultorFilter = '';
        this.applyAndLoad();
    }

    handleRefresh()       { this.loadData(); }
    handleTabClick(event) { this.activeTab = event.currentTarget.dataset.tab; }

    /* ── Sorting (header click) ── */
    handleHeaderClick(event) {
        const field = event.currentTarget.dataset.field;
        if (!field) return;
        if (this.sortField === field) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortField = field;
            this.sortDirection = 'asc';
        }
        this.refreshDisplayRows();
    }

    /* ── Pagination handlers ── */
    handlePageClick(event) {
        const page = parseInt(event.currentTarget.dataset.page, 10);
        if (page && page !== this.currentPage) { this.currentPage = page; this.refreshDisplayRows(); }
    }
    handlePrevPage() { if (!this.isFirstPage) { this.currentPage--; this.refreshDisplayRows(); } }
    handleNextPage() { if (!this.isLastPage)  { this.currentPage++; this.refreshDisplayRows(); } }
    handlePageSizeChange(event) {
        this.pageSize    = parseInt(event.target.value, 10);
        this.currentPage = 1;
        this.refreshDisplayRows();
    }

    /* ── Inline editing ── */
    handleCellEdit(event) {
        const id    = event.target.dataset.id;
        const field = event.target.dataset.field;
        if (!id || !field) return;
        let value = event.target.value;
        if (field === 'HH_Total__c') value = value === '' ? null : parseFloat(value);
        const next = { ...this.draftMap };
        next[id] = { ...(next[id] || {}), [field]: value };
        this.draftMap = next;
    }

    handleDiscardDrafts() {
        this.draftMap = {};
        this.refreshDisplayRows();
    }

    async handleSaveDrafts() {
        if (!this.hasDrafts) return;
        this.isSaving = true;
        try {
            const records = Object.entries(this.draftMap).map(([id, fields]) => {
                const record = { Id: id };
                Object.keys(fields).forEach(k => {
                    if (EDITABLE_FIELDS.has(k)) record[k] = fields[k];
                });
                return record;
            });
            await updateBacklogRecords({ records });
            this.dispatchEvent(new ShowToastEvent({
                title: 'Cambios guardados',
                message: `${records.length} registro(s) actualizado(s).`,
                variant: 'success'
            }));
            await this.loadData();
        } catch (error) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Error al guardar',
                message: this.reduceError(error),
                variant: 'error'
            }));
        } finally {
            this.isSaving = false;
        }
    }

    async handleRecalcular() {
        this.isRecalculating = true;
        try {
            const updated = await recalcularIndicadores();
            this.dispatchEvent(new ShowToastEvent({
                title: 'Recálculo completado',
                message: `Se actualizaron los indicadores de ${updated} demanda(s).`,
                variant: 'success'
            }));
            await this.loadData();
        } catch (error) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Error al recalcular',
                message: this.reduceError(error),
                variant: 'error'
            }));
        } finally {
            this.isRecalculating = false;
        }
    }

    reduceError(error) {
        if (Array.isArray(error?.body)) return error.body.map(i => i.message).join(', ');
        return error?.body?.message || error?.message || 'Error desconocido';
    }
}
