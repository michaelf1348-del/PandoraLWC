import { LightningElement } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getActiveTickets from '@salesforce/apex/PandoraTimeController.getActiveTickets';
import saveTimeEntries from '@salesforce/apex/PandoraTimeController.saveTimeEntries';

const WEEKDAYS = [
    { key: 'dom', label: 'Dom' },
    { key: 'lun', label: 'Lun' },
    { key: 'mar', label: 'Mar' },
    { key: 'mie', label: 'Mié' },
    { key: 'jue', label: 'Jue' },
    { key: 'vie', label: 'Vie' },
    { key: 'sab', label: 'Sáb' }
];

const MONTH_NAMES = [
    'Enero',
    'Febrero',
    'Marzo',
    'Abril',
    'Mayo',
    'Junio',
    'Julio',
    'Agosto',
    'Septiembre',
    'Octubre',
    'Noviembre',
    'Diciembre'
];

export default class DailyTimeCalendar extends LightningElement {
    weekdays = WEEKDAYS;
    tickets = [];
    calendarDays = [];
    loading = false;

    currentDate = new Date();
    selectedDate = this.formatDateForInput(new Date());
    objetivoHoras = 8;

    connectedCallback() {
        this.buildCalendar();
        this.loadTickets();
    }

    get currentMonthName() {
        return MONTH_NAMES[this.currentDate.getMonth()];
    }

    get currentYear() {
        return this.currentDate.getFullYear();
    }

    get selectedDateLabel() {
        if (!this.selectedDate) {
            return 'Sin selección';
        }

        const [year, month, day] = this.selectedDate.split('-');
        return `${day}/${month}/${year}`;
    }

    get hasTickets() {
        return Array.isArray(this.tickets) && this.tickets.length > 0;
    }

    get totalHorasDia() {
        return this.tickets
            .reduce((acc, ticket) => acc + (Number(ticket.horasInput) || 0), 0)
            .toFixed(2)
            .replace(/\.00$/, '');
    }

    get restantesHoras() {
        const remaining = this.objetivoHoras - Number(this.totalHorasDia);
        return Math.max(remaining, 0)
            .toFixed(2)
            .replace(/\.00$/, '');
    }

    get progressPercentage() {
        if (!this.objetivoHoras || this.objetivoHoras <= 0) {
            return 0;
        }

        const percentage = (Number(this.totalHorasDia) / this.objetivoHoras) * 100;
        return Math.max(0, Math.min(percentage, 100));
    }

    get progressPercentageLabel() {
        return Math.round(this.progressPercentage);
    }

    get progressStyle() {
        return `width: ${this.progressPercentage}%;`;
    }

    get pendingEntriesCount() {
        return this.tickets.filter((ticket) => ticket.isEdited).length;
    }

    get saveDisabled() {
        return this.loading || this.pendingEntriesCount === 0;
    }

    handlePrevMonth() {
        this.currentDate = new Date(
            this.currentDate.getFullYear(),
            this.currentDate.getMonth() - 1,
            1
        );
        this.buildCalendar();
    }

    handleNextMonth() {
        this.currentDate = new Date(
            this.currentDate.getFullYear(),
            this.currentDate.getMonth() + 1,
            1
        );
        this.buildCalendar();
    }

    handleDayClick(event) {
        const selected = event.currentTarget.dataset.date;
        if (!selected) {
            return;
        }

        this.selectedDate = selected;
        this.buildCalendar();
        this.loadTickets();
    }

    handleHoursChange(event) {
        const ticketId = event.target.dataset.id;
        const value = event.detail.value;

        this.tickets = this.tickets.map((ticket) => {
            if (ticket.id !== ticketId) {
                return ticket;
            }

            const horasInput =
                value === '' || value === null || value === undefined
                    ? 0
                    : Number(value);

            const updated = {
                ...ticket,
                horasInput,
                isEdited: true
            };

            updated.rowClass = this.computeRowClass(updated);
            return updated;
        });
    }

    handleNoFactChange(event) {
        const ticketId = event.target.dataset.id;
        const checked = event.target.checked;

        this.tickets = this.tickets.map((ticket) => {
            if (ticket.id !== ticketId) {
                return ticket;
            }

            const updated = {
                ...ticket,
                noFacturable: checked,
                isEdited: true
            };

            updated.rowClass = this.computeRowClass(updated);
            return updated;
        });
    }

    async loadTickets() {
        this.loading = true;

        try {
            const result = await getActiveTickets({ selectedDate: this.selectedDate });
            this.tickets = (result || []).map((ticket) => this.normalizeTicket(ticket));
        } catch (error) {
            this.tickets = [];
            this.showToast('Error', this.reduceError(error), 'error');
        } finally {
            this.loading = false;
        }
    }

    async handleSave() {
        const recordsToSave = this.tickets.filter(
            (ticket) =>
                ticket.isEdited &&
                ((Number(ticket.horasInput) || 0) > 0 || ticket.noFacturable === true)
        );

        if (!recordsToSave.length) {
            this.showToast(
                'Sin cambios válidos',
                'Debes ingresar horas o marcar No Facturable en al menos una fila editada.',
                'warning'
            );
            return;
        }

        this.loading = true;

        try {
            const payload = recordsToSave.map((ticket) => ({
                id: ticket.id,
                horas: Number(ticket.horasInput) || 0,
                noFacturable: Boolean(ticket.noFacturable),
                fecha: this.selectedDate
            }));

            const savedCount = await saveTimeEntries({
                payloadJson: JSON.stringify(payload)
            });

            this.tickets = this.tickets.map((ticket) => {
                const savedItem = recordsToSave.find((row) => row.id === ticket.id);

                if (!savedItem) {
                    return ticket;
                }

                const updated = {
                    ...ticket,
                    horasImputadas: Number(savedItem.horasInput) || 0,
                    hasImputedHours: (Number(savedItem.horasInput) || 0) > 0,
                    isEdited: false
                };

                updated.rowClass = this.computeRowClass(updated);
                return updated;
            });

            this.showToast(
                'Éxito',
                `Se guardaron ${savedCount} imputación(es) correctamente en Imputacion__c.`,
                'success'
            );
        } catch (error) {
            this.showToast('Error', this.reduceError(error), 'error');
        } finally {
            this.loading = false;
        }
    }

    buildCalendar() {
        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth();
        const firstDayOfMonth = new Date(year, month, 1);
        const lastDayOfMonth = new Date(year, month + 1, 0);
        const daysInMonth = lastDayOfMonth.getDate();
        const firstWeekday = firstDayOfMonth.getDay();
        const today = this.formatDateForInput(new Date());

        const days = [];

        for (let i = 0; i < firstWeekday; i += 1) {
            days.push({
                key: `empty-${month}-${i}`,
                isEmpty: true
            });
        }

        for (let dayNumber = 1; dayNumber <= daysInMonth; dayNumber += 1) {
            const date = new Date(year, month, dayNumber);
            const isoDate = this.formatDateForInput(date);
            const dayOfWeek = date.getDay();
            const disabled = dayOfWeek === 0 || dayOfWeek === 6;

            days.push({
                key: isoDate,
                label: dayNumber,
                isoDate,
                disabled,
                isEmpty: false,
                buttonClass: this.computeDayClass({
                    disabled,
                    isToday: isoDate === today,
                    isSelected: isoDate === this.selectedDate
                })
            });
        }

        this.calendarDays = days;
    }

    normalizeTicket(ticket) {
        const normalized = {
            id: ticket.id,
            caseNumber: ticket.caseNumber,
            subject: ticket.subject,
            status: ticket.status,
            recordLink: ticket.recordLink,
            horasImputadas: Number(ticket.horasImputadas) || 0,
            horasInput: 0,
            noFacturable: false,
            hasImputedHours: false,
            isEdited: false
        };

        normalized.rowClass = this.computeRowClass(normalized);
        return normalized;
    }

    computeDayClass({ isSelected, isToday, disabled }) {
        let cssClass = 'cal-day selectable';

        if (disabled) {
            cssClass += ' disabled-day';
        }

        if (isToday) {
            cssClass += ' today';
        }

        if (isSelected) {
            cssClass += ' active';
        }

        return cssClass;
    }

    computeRowClass(ticket) {
        let cssClass = 'ticket-row';

        if (ticket.isEdited) {
            cssClass += ' edited';
        }

        if (ticket.hasImputedHours) {
            cssClass += ' has-imputed';
        }

        return cssClass;
    }

    formatDateForInput(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    reduceError(error) {
        if (Array.isArray(error?.body)) {
            return error.body.map((entry) => entry.message).join(', ');
        }

        return error?.body?.message || error?.message || 'Ocurrió un error inesperado.';
    }

    showToast(title, message, variant) {
        this.dispatchEvent(
            new ShowToastEvent({
                title,
                message,
                variant
            })
        );
    }
}
