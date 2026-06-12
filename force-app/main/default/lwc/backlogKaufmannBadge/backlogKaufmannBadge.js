import { LightningElement, api } from 'lwc';

export default class BacklogKaufmannBadge extends LightningElement {
    @api value;

    get badgeClass() {
        const v = (this.value || '').toLowerCase();
        if (v.includes('curso'))                                        return 'bkb bkb--curso';
        if (v.includes('pendiente') || v.includes('inicio'))           return 'bkb bkb--pendiente';
        if (v.includes('bloquea') || v.includes('cancel') ||
            v.includes('cierr') || v.includes('rechaz'))               return 'bkb bkb--bloqueado';
        if (v.includes('complet') || v.includes('cerrad') ||
            v.includes('finaliz'))                                      return 'bkb bkb--completado';
        return 'bkb bkb--default';
    }
}
