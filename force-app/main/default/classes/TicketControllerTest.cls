@IsTest
private class TicketControllerTest {

    @TestSetup
    static void setup() {
        // La org tiene campos custom requeridos en Account
        // (Categoria_de_Cliente__c, RUT__c). Si el negocio agrega más en el
        // futuro, este setup va a romper igual que cualquier otro test:
        // ese es el comportamiento esperado en SF cuando el schema cambia.
        Account acc = buildAccount('Kaufmann', '11111111-1');
        insert acc;

        List<Case> cases = new List<Case>();
        for (Integer i = 0; i < 3; i++) {
            cases.add(new Case(
                AccountId = acc.Id,
                Subject = 'Test Ticket ' + i,
                Status = 'New',
                Priority = 'Medium',
                Origin = 'Web'
            ));
        }
        insert cases;
    }

    private static Account buildAccount(String name, String rut) {
        return new Account(
            Name = name,
            RUT__c = rut,
            Categoria_de_Cliente__c = 'Nacional'
        );
    }

    @IsTest
    static void getTicketsByAccount_returnsRelatedCases() {
        Account acc = [SELECT Id FROM Account WHERE Name = 'Kaufmann' LIMIT 1];

        Test.startTest();
        List<TicketController.TicketWrapper> tickets =
            TicketController.getTicketsByAccount(acc.Id);
        Test.stopTest();

        System.assertEquals(3, tickets.size(), 'Debería devolver los 3 casos insertados');
        System.assertNotEquals(null, tickets[0].CaseNumber, 'CaseNumber no debería ser null');
        System.assert(tickets[0].CaseUrl.startsWith('/'), 'CaseUrl debe iniciar con "/"');
    }

    @IsTest
    static void getTicketsByAccount_withNullId_returnsEmpty() {
        Test.startTest();
        List<TicketController.TicketWrapper> tickets =
            TicketController.getTicketsByAccount(null);
        Test.stopTest();

        System.assertEquals(0, tickets.size(), 'AccountId null debe devolver lista vacía');
    }

    @IsTest
    static void getTicketsByAccount_withUnknownAccount_returnsEmpty() {
        Account empty = buildAccount('NoTickets', '22222222-2');
        insert empty;

        Test.startTest();
        List<TicketController.TicketWrapper> tickets =
            TicketController.getTicketsByAccount(empty.Id);
        Test.stopTest();

        System.assertEquals(0, tickets.size(), 'Cuenta sin casos debe devolver lista vacía');
    }
}
