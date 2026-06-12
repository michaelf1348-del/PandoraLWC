({
    afterRender: function (component, helper) {
        this.superAfterRender();
        try {
            const host = component.getElement();
            if (!host || !host.closest) return;
            const modalContainer = host.closest('.slds-modal__container');
            if (!modalContainer) return;
            modalContainer.style.width = '96%';
            modalContainer.style.maxWidth = '92rem';
        } catch (e) {
            /* ignore: si Salesforce cambia el DOM del quick action */
        }
    }
});