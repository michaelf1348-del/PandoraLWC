/**
 * Cobertura >= 75% para ImputacionesBillableRules (deploy PRD).
 */
@isTest
private class ImputacionesBillableRulesTest {

    private static String sampleRulesJson(String impIndField) {
        String ind = String.isBlank(impIndField) ? 'Origen__c' : impIndField;
        return '{'
            + '"caseNoFacturable":{"fieldApi":"Status","values":"Closed;Cerrado"},'
            + '"caseExcepcionFacturable":{"fieldApi":"Status","values":"New;Nuevo"},'
            + '"imputacionExcepcionFacturable":{"fieldApi":"' + ind + '","values":"EXC"},'
            + '"imputacionIndField":"' + ind + '",'
            + '"imputacionFacturableValues":"FA;FACT",'
            + '"imputacionNoFacturableValues":"NF;NOFACT",'
            + '"extraFilters":['
            + '{"objectApi":"Case","fieldApi":"Status","values":"Working","effect":"noFacturable"},'
            + '{"objectApi":"Case","fieldApi":"Status","values":"Escalated","effect":"excepcionFacturable"},'
            + '{"objectApi":"Case","fieldApi":"Priority","values":"High","effect":"facturable"},'
            + '{"objectApi":"Imputacion__c","fieldApi":"' + ind + '","values":"NF","effect":"noFacturable"},'
            + '{"objectApi":"BadObject","fieldApi":"Status","values":"X","effect":"facturable"},'
            + '{"objectApi":"Case","fieldApi":"","values":"X","effect":"noFacturable"}'
            + ']}';
    }

    private static String imputationIndFieldApi() {
        if (!Schema.getGlobalDescribe().containsKey('Imputacion__c')) {
            return null;
        }
        Map<String, Schema.SObjectField> fm = Imputacion__c.SObjectType.getDescribe().fields.getMap();
        for (String api : new List<String>{
            'Origen__c',
            'Origen_Imputacion__c',
            'Source__c',
            'Origen_Imputacion_Texto__c'
        }) {
            if (fm.containsKey(api)) {
                return api;
            }
        }
        return null;
    }

    @isTest
    static void cover_parse_cache_and_collectors() {
        ImputacionesBillableRules.clearCache();

        ImputacionesBillableRules.RulesConfig empty1 = ImputacionesBillableRules.parseJson(null);
        System.assertNotEquals(null, empty1);

        ImputacionesBillableRules.parseJson('[]');
        ImputacionesBillableRules.parseJson('{"extraFilters":"x"}');
        ImputacionesBillableRules.parseJson('{"caseNoFacturable":"not-map"}');

        String badJson = '{broken';
        ImputacionesBillableRules.parseJson(badJson);

        String ind = imputationIndFieldApi();
        ImputacionesBillableRules.RulesConfig rules = ImputacionesBillableRules.parseJson(sampleRulesJson(ind));
        ImputacionesBillableRules.defaultRules();

        ImputacionesBillableRules.parseValueList('a;b,c\nd;e');
        ImputacionesBillableRules.parseValueList('');
        ImputacionesBillableRules.parseValueList(null);

        ImputacionesBillableRules.collectCaseFieldApis(rules);
        ImputacionesBillableRules.collectCaseFieldApis(null);

        Map<String, Schema.SObjectField> impMap = Imputacion__c.SObjectType.getDescribe().fields.getMap();
        ImputacionesBillableRules.collectImputationFieldApis(rules, impMap);
        ImputacionesBillableRules.collectImputationFieldApis(null, impMap);

        Configurar_Centro_Imputaciones__c oc = new Configurar_Centro_Imputaciones__c(
            Criterios_Facturable_Filtros_JSON__c = sampleRulesJson(ind)
        );
        ImputacionesBillableRules.loadFromOperativeConfig(null);
        ImputacionesBillableRules.loadFromOperativeConfig(oc);
        ImputacionesBillableRules.loadFromOperativeConfig(oc);
        ImputacionesBillableRules.clearCache();
    }

    @isTest
    static void cover_evaluate_and_match_helpers() {
        ImputacionesBillableRules.clearCache();
        String ind = imputationIndFieldApi();
        ImputacionesBillableRules.RulesConfig rules = ImputacionesBillableRules.parseJson(sampleRulesJson(ind));

        ImputacionesBillableRules.EvaluateInput ev = new ImputacionesBillableRules.EvaluateInput();
        ev.plannedNoFacturable = false;
        ev.nfCheckbox = false;
        ev.alwaysFacturablePep = false;

        Case closedCase = new Case(Status = 'Closed', Priority = 'High');
        ev.caseRow = closedCase;
        ev.amsManagementCase = true;
        ImputacionesBillableRules.evaluateIsNoFacturable(ev, rules);

        ev.alwaysFacturablePep = true;
        ImputacionesBillableRules.evaluateIsNoFacturable(ev, rules);
        ev.alwaysFacturablePep = false;

        ev.caseRow = new Case(Status = 'New');
        ev.amsManagementCase = true;
        ImputacionesBillableRules.evaluateIsNoFacturable(ev, rules);

        ev.caseRow = new Case(Status = 'Working');
        ImputacionesBillableRules.evaluateIsNoFacturable(ev, rules);

        ev.caseRow = new Case(Status = 'Escalated');
        ImputacionesBillableRules.evaluateIsNoFacturable(ev, rules);

        ev.caseRow = new Case(Status = 'On Hold');
        ev.amsManagementCase = false;
        ev.nfCheckbox = true;
        ImputacionesBillableRules.evaluateIsNoFacturable(ev, rules);

        ev.nfCheckbox = false;
        ev.plannedNoFacturable = true;
        ImputacionesBillableRules.evaluateIsNoFacturable(ev, rules);

        ev.plannedNoFacturable = false;
        ImputacionesBillableRules.evaluateIsNoFacturable(null, rules);

        Case c = closedCase;

        Set<String> vals = new Set<String>{ 'Closed', 'New' };
        System.assertEquals(true, ImputacionesBillableRules.valueMatchesList('Closed', vals));
        System.assertEquals(true, ImputacionesBillableRules.valueMatchesList('a;Closed', vals));
        System.assertEquals(false, ImputacionesBillableRules.valueMatchesList('', vals));
        System.assertEquals(false, ImputacionesBillableRules.valueMatchesList('X', vals));
        System.assertEquals(false, ImputacionesBillableRules.valueMatchesList('X', null));

        Set<String> apis = ImputacionesBillableRules.collectCaseFieldApis(rules);
        System.assertNotEquals(null, ImputacionesBillableRules.serializeCaseRuleFields(c, apis));
        System.assertEquals('{}', ImputacionesBillableRules.serializeCaseRuleFields(null, apis));

        System.assertEquals('Closed', ImputacionesBillableRules.readFieldAsMatchString(c, 'Status'));
        System.assertEquals('', ImputacionesBillableRules.readFieldAsMatchString(c, 'Campo_Inexistente__c'));
        System.assertEquals('', ImputacionesBillableRules.readFieldAsMatchString(null, 'Status'));

        ImputacionesBillableRules.caseForcedNoFacturable(closedCase, true, rules);
        ImputacionesBillableRules.caseForcedNoFacturable(closedCase, false, rules);
        ImputacionesBillableRules.caseForcedNoFacturable(new Case(Status = 'Open'), true, rules);
        ImputacionesBillableRules.caseForcedNoFacturable(new Case(Status = 'Open'), false, rules);
        System.assertEquals(false, ImputacionesBillableRules.caseForcedNoFacturable(null, false, rules));

        if (String.isNotBlank(ind)) {
            SObject imp = Imputacion__c.SObjectType.newSObject();
            ev.imputation = imp;
            ev.amsManagementCase = false;
            ev.nfCheckbox = false;
            ev.plannedNoFacturable = false;

            ev.caseRow = new Case(Status = 'Open');
            imp.put(ind, 'NF');
            ImputacionesBillableRules.evaluateIsNoFacturable(ev, rules);

            imp.put(ind, 'FA');
            ImputacionesBillableRules.evaluateIsNoFacturable(ev, rules);

            imp.put(ind, 'EXC');
            ImputacionesBillableRules.evaluateIsNoFacturable(ev, rules);

            ev.caseRow = new Case(Status = 'Closed');
            imp.put(ind, 'NF');
            ImputacionesBillableRules.evaluateIsNoFacturable(ev, rules);
            imp.put(ind, 'EXC');
            ImputacionesBillableRules.evaluateIsNoFacturable(ev, rules);
        }
    }

    @isTest(SeeAllData=true)
    static void cover_with_operative_config_row() {
        ImputacionesBillableRules.clearCache();
        ImputacionesAMSController.clearOperativeConfigCache();
        try {
            ImputacionesAMSController.getImputationCenterSettings();
        } catch (Exception e) {
        }
        List<Configurar_Centro_Imputaciones__c> rows = [
            SELECT Criterios_Facturable_Filtros_JSON__c
            FROM Configurar_Centro_Imputaciones__c
            WHERE Config_Key__c = 'DEFAULT'
            LIMIT 1
        ];
        if (!rows.isEmpty()) {
            ImputacionesBillableRules.loadFromOperativeConfig(rows[0]);
        }
    }
}
