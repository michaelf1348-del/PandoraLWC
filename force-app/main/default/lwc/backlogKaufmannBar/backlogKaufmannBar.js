import { LightningElement, api } from 'lwc';

export default class BacklogKaufmannBar extends LightningElement {
    @api value;

    get displayValue() {
        const n = parseFloat(this.value);
        return isNaN(n) ? 0 : Math.round(n * 10) / 10;
    }

    get fillStyle() {
        const pct = Math.min(Math.max(parseFloat(this.value) || 0, 0), 100);
        let color;
        if (pct >= 80)      color = '#16a34a';
        else if (pct >= 40) color = '#f59e0b';
        else if (pct > 0)   color = '#e53935';
        else                color = '#d1d5db';
        return `width:${pct}%;background-color:${color};`;
    }
}
