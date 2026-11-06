"""Authorization logic for CareLoop, registered with CARE's controller.

Every check is scoped to a **facility**. A clinician who can approve drafts at
one facility must not thereby be able to approve them at another, and the
queryset filters in the viewsets derive from these same checks rather than
re-implementing them.
"""

from care.security.authorization.base import (
    AuthorizationController,
    AuthorizationHandler,
)

from care_careloop.security.permissions import CareloopPermissions


class CareloopAccess(AuthorizationHandler):
    def can_run_careloop_campaign(self, user, facility) -> bool:
        return self.check_permission_in_facility_organization(
            [CareloopPermissions.can_run_careloop_campaign.name],
            user,
            facility=facility,
        )

    def can_view_careloop_draft(self, user, facility) -> bool:
        return self.check_permission_in_facility_organization(
            [CareloopPermissions.can_view_careloop_draft.name],
            user,
            facility=facility,
        )

    def can_approve_careloop_draft(self, user, facility) -> bool:
        """Approval is the act that writes to the chart, so it is checked alone.

        Deliberately *not* implied by ``can_view_careloop_draft``: seeing the
        queue and signing off a plan are different privileges.
        """
        return self.check_permission_in_facility_organization(
            [CareloopPermissions.can_approve_careloop_draft.name],
            user,
            facility=facility,
        )


AuthorizationController.register_internal_controller(CareloopAccess)
