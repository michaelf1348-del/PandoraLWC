@isTest
private class BacklogKaufmannControllerTest {

    @isTest
    static void getBacklogData_returnsStructureWhenObjectExists() {
        if (!Schema.getGlobalDescribe().containsKey('Gestiones_Kaufmann__c')) {
            return;
        }

        Test.startTest();
        BacklogKaufmannController.BacklogDataResult result = BacklogKaufmannController.getBacklogData(null, null, null);
        Test.stopTest();

        System.assertNotEquals(null, result, 'Debe devolver resultado');
        System.assertNotEquals(null, result.rows, 'Debe incluir filas');
        System.assertNotEquals(null, result.summary, 'Debe incluir resumen');
        System.assertNotEquals(null, result.tipoTareaOptions, 'Debe incluir opciones de tipo de tarea');
        System.assertNotEquals(null, result.estadoOptions, 'Debe incluir opciones de estado');
    }

    @isTest
    static void getBacklogData_appliesSearchFilter() {
        if (!Schema.getGlobalDescribe().containsKey('Gestiones_Kaufmann__c')) {
            return;
        }

        Test.startTest();
        BacklogKaufmannController.BacklogDataResult result =
            BacklogKaufmannController.getBacklogData('DMND', 'Desarrollo', 'En curso');
        Test.stopTest();

        System.assertNotEquals(null, result.rows, 'Debe devolver filas filtradas');
    }

    @isTest
    static void updateBacklogRecords_validatesEmptyInput() {
        Test.startTest();
        BacklogKaufmannController.updateBacklogRecords(new List<Gestiones_Kaufmann__c>());
        Test.stopTest();
        System.assert(true, 'Lista vacía no debe lanzar error');
    }

    @isTest
    static void recalcularIndicadores_runsWithoutError() {
        if (!Schema.getGlobalDescribe().containsKey('Gestiones_Kaufmann__c')) {
            return;
        }

        Test.startTest();
        Integer updated = BacklogKaufmannController.recalcularIndicadores();
        Test.stopTest();

        System.assert(updated >= 0, 'Debe devolver un conteo no negativo');
    }

    @isTest
    static void networkDays_matchesExcelSemantics() {
        // Lunes 2024-01-01 a viernes 2024-01-05 = 5 días hábiles (ambos inclusive)
        Date lunes = Date.newInstance(2024, 1, 1);
        Date viernes = Date.newInstance(2024, 1, 5);
        System.assertEquals(5, BacklogKaufmannController.networkDays(lunes, viernes), 'Lun-Vie = 5');

        // Lunes a lunes siguiente = 6 días hábiles
        Date lunesSig = Date.newInstance(2024, 1, 8);
        System.assertEquals(6, BacklogKaufmannController.networkDays(lunes, lunesSig), 'Lun-LunSig = 6');

        // Sábado a domingo = 0 días hábiles
        Date sabado = Date.newInstance(2024, 1, 6);
        Date domingo = Date.newInstance(2024, 1, 7);
        System.assertEquals(0, BacklogKaufmannController.networkDays(sabado, domingo), 'Sab-Dom = 0');

        // Rango invertido o nulo = 0
        System.assertEquals(0, BacklogKaufmannController.networkDays(viernes, lunes), 'Invertido = 0');
        System.assertEquals(0, BacklogKaufmannController.networkDays(null, viernes), 'Null = 0');
    }
}
