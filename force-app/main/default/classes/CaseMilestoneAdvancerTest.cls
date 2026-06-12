@IsTest
private class CaseMilestoneAdvancerTest {

    @IsTest
    static void isDirectAdvanceStatus_recognizesClosureStatuses() {
        System.assertEquals(true, CaseMilestoneAdvancer.isDirectAdvanceStatus('Cierre'));
        System.assertEquals(true, CaseMilestoneAdvancer.isDirectAdvanceStatus('Cerrado'));
        System.assertEquals(true, CaseMilestoneAdvancer.isDirectAdvanceStatus('Closed'));
        System.assertEquals(true, CaseMilestoneAdvancer.isDirectAdvanceStatus('Cancelado'));
        System.assertEquals(false, CaseMilestoneAdvancer.isDirectAdvanceStatus('Aprobacion'));
        System.assertEquals(false, CaseMilestoneAdvancer.isDirectAdvanceStatus('Aprobaci\u00F3n'));
    }
}
