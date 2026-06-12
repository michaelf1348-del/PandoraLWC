@isTest
private class ImpBillableCriteriaInvocableTest {
    private static void upsertDefaultOperativeConfig() {
        if (!Schema.getGlobalDescribe().containsKey('Configurar_Centro_Imputaciones__c')) {
            return;
        }
        List<Configurar_Centro_Imputaciones__c> rows = [
            SELECT Id
            FROM Configurar_Centro_Imputaciones__c
            WHERE Config_Key__c = 'DEFAULT'
            LIMIT 1
        ];
        Configurar_Centro_Imputaciones__c rec =
            rows.isEmpty()
                ? new Configurar_Centro_Imputaciones__c(Name = 'DEFAULT', Config_Key__c = 'DEFAULT')
                : new Configurar_Centro_Imputaciones__c(Id = rows[0].Id);
        rec.Criterios_Facturable_Filtros_JSON__c = '{"caseNoFacturable":{"fieldApi":"Status","values":"Closed"}}';
        if (rec.Id == null) {
            insert rec;
        } else {
            update rec;
        }
        ImputacionesAMSController.clearOperativeConfigCache();
        ImputacionesBillableRules.clearCache();
    }

    @isTest
    static void update_json_success() {
        upsertDefaultOperativeConfig();
        ImputacionesBillableCriteriaInvocable.Request req = new ImputacionesBillableCriteriaInvocable.Request();
        req.billableCriteriaFiltersJson =
            '{"caseNoFacturable":{"fieldApi":"Status","values":"Closed;Cerrado"},"caseExcepcionFacturable":{"fieldApi":"Status","values":"New"}}';

        Test.startTest();
        List<ImputacionesBillableCriteriaInvocable.Result> res =
            ImputacionesBillableCriteriaInvocable.updateBillableCriteriaJson(
                new List<ImputacionesBillableCriteriaInvocable.Request>{ req }
            );
        Test.stopTest();

        System.assertEquals(1, res.size(), 'Un resultado');
        System.assertEquals(true, res[0].success, res[0].message);
        System.assertEquals('JSON actualizado.', res[0].message);

        Configurar_Centro_Imputaciones__c oc = ImputacionesOperativeConfigLoader.loadDefault();
        System.assertNotEquals(null, oc, 'Config operativo');
        System.assert(
            String.isNotBlank(oc.Criterios_Facturable_Filtros_JSON__c),
            'JSON persistido'
        );
    }

    @isTest
    static void reject_null_or_empty_requests() {
        List<ImputacionesBillableCriteriaInvocable.Result> r1 =
            ImputacionesBillableCriteriaInvocable.updateBillableCriteriaJson(null);
        System.assertEquals(false, r1[0].success);
        System.assertEquals('JSON vacio.', r1[0].message);

        List<ImputacionesBillableCriteriaInvocable.Result> r2 =
            ImputacionesBillableCriteriaInvocable.updateBillableCriteriaJson(
                new List<ImputacionesBillableCriteriaInvocable.Request>()
            );
        System.assertEquals(false, r2[0].success);

        ImputacionesBillableCriteriaInvocable.Request req = new ImputacionesBillableCriteriaInvocable.Request();
        req.billableCriteriaFiltersJson = '   ';
        List<ImputacionesBillableCriteriaInvocable.Result> r3 =
            ImputacionesBillableCriteriaInvocable.updateBillableCriteriaJson(
                new List<ImputacionesBillableCriteriaInvocable.Request>{ req }
            );
        System.assertEquals(false, r3[0].success);
        System.assertEquals('JSON vacio.', r3[0].message);
    }

    @isTest
    static void trims_json_before_save() {
        upsertDefaultOperativeConfig();
        ImputacionesBillableCriteriaInvocable.Request req = new ImputacionesBillableCriteriaInvocable.Request();
        req.billableCriteriaFiltersJson = '  {"caseNoFacturable":{"fieldApi":"","values":""}}  ';

        List<ImputacionesBillableCriteriaInvocable.Result> res =
            ImputacionesBillableCriteriaInvocable.updateBillableCriteriaJson(
                new List<ImputacionesBillableCriteriaInvocable.Request>{ req }
            );
        System.assertEquals(true, res[0].success, res[0].message);
    }
}
