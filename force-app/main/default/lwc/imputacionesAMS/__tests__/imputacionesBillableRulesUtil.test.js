import {
    evaluatePendingRowNoFacturable,
    parseBillableRulesFromSettings,
    computePendingBillableBreakdown,
    resolveConsultantNoFacturableForSave,
    rowNoFactCheckboxLocked
} from '../imputacionesBillableRulesUtil';

const RULES = parseBillableRulesFromSettings({
    billableCriteriaFiltersJson: JSON.stringify({
        caseNoFacturable: { fieldApi: 'Reason', values: 'Gestion Interna' },
        caseExcepcionFacturable: { fieldApi: '', values: '' },
        imputacionIndField: 'Ind_Imputacion__c',
        imputacionFacturableValues: 'FA',
        imputacionNoFacturableValues: 'NF',
        extraFilters: []
    })
});

describe('imputacionesBillableRulesUtil — preview JSON (réplica Ind)', () => {
    it('no pre-marca ni bloquea la casilla por isAmsManagementCase', () => {
        const row = {
            isAmsManagementCase: true,
            caseNoFactLocked: true,
            plannedNoFacturable: false
        };
        expect(rowNoFactCheckboxLocked(row)).toBe(false);
        expect(resolveConsultantNoFacturableForSave(row)).toBe(false);
    });

    it('guardado usa solo plannedNoFacturable del usuario', () => {
        expect(
            resolveConsultantNoFacturableForSave({
                isAmsManagementCase: true,
                plannedNoFacturable: true
            })
        ).toBe(true);
        expect(
            resolveConsultantNoFacturableForSave({
                isAmsManagementCase: true,
                plannedNoFacturable: false
            })
        ).toBe(false);
    });

    it('vista previa: reglas Case, AMS (pestaña) y checkbox', () => {
        const clientRow = {
            isAmsManagementCase: true,
            plannedNoFacturable: false,
            caseRuleFieldsJson: JSON.stringify({ Reason: 'Service Request' })
        };
        expect(evaluatePendingRowNoFacturable(clientRow, RULES)).toBe(true);

        const gestionRow = {
            isAmsManagementCase: false,
            plannedNoFacturable: false,
            caseRuleFieldsJson: JSON.stringify({ Reason: 'Gestion Interna' })
        };
        expect(evaluatePendingRowNoFacturable(gestionRow, RULES)).toBe(true);

        const checkedRow = {
            isAmsManagementCase: true,
            plannedNoFacturable: true,
            caseRuleFieldsJson: JSON.stringify({ Reason: 'Service Request' })
        };
        expect(evaluatePendingRowNoFacturable(checkedRow, RULES)).toBe(true);
    });

    it('PEP vacaciones (allowsFutureDates) siempre facturable en preview', () => {
        const vacRow = {
            allowsFutureDates: true,
            isAmsManagementCase: true,
            plannedNoFacturable: true,
            caseRuleFieldsJson: JSON.stringify({ Reason: 'Gestion Interna' })
        };
        expect(evaluatePendingRowNoFacturable(vacRow, RULES)).toBe(false);
    });

    it('computePendingBillableBreakdown suma horas por fechas', () => {
        const rows = [
            {
                caseId: 'a',
                plannedHours: 2,
                plannedNoFacturable: false,
                caseRuleFieldsJson: JSON.stringify({ Reason: 'Service Request' }),
                isAmsManagementCase: false
            },
            {
                caseId: 'b',
                plannedHours: 1,
                plannedNoFacturable: true,
                isAmsManagementCase: false
            }
        ];
        const b = computePendingBillableBreakdown(rows, ['a', 'b'], ['2026-05-01', '2026-05-02'], RULES);
        expect(b.fact).toBe(4);
        expect(b.noFact).toBe(2);
        expect(b.total).toBe(6);
    });
});
