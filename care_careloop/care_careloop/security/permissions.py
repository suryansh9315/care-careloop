"""CareLoop permissions, registered into CARE's permission registry.

Three permissions rather than one, because running a campaign and approving a
clinical plan are different acts:

* ``can_run_careloop_campaign`` — build a care-gap cohort and dial it. Operational.
* ``can_view_careloop_draft`` — read the review queue and a draft's contents.
* ``can_approve_careloop_draft`` — turn a draft into real chart entries.

Approval is restricted to clinical and administrative roles. A draft becoming a
`MedicationRequest` and coded `Observation`s is a clinical act, so it is not
something a volunteer or general staff account should be able to do, even though
they may legitimately see the queue.
"""

import enum

from care.security.permissions.base import PermissionController
from care.security.permissions.constants import Permission, PermissionContext
from care.security.roles.role import (
    ADMIN_ROLE,
    ADMINISTRATOR,
    DOCTOR_ROLE,
    FACILITY_ADMIN_ROLE,
    NURSE_ROLE,
    STAFF_ROLE,
)

#: Who may operate campaigns and read the queue.
CARELOOP_OPERATIONAL_ROLES = [
    DOCTOR_ROLE,
    NURSE_ROLE,
    STAFF_ROLE,
    ADMIN_ROLE,
    FACILITY_ADMIN_ROLE,
    ADMINISTRATOR,
]

#: Who may approve a draft into the patient's chart. Narrower on purpose.
CARELOOP_APPROVER_ROLES = [
    DOCTOR_ROLE,
    NURSE_ROLE,
    ADMIN_ROLE,
    FACILITY_ADMIN_ROLE,
    ADMINISTRATOR,
]


class CareloopPermissions(enum.Enum):
    can_run_careloop_campaign = Permission(
        "Can run CareLoop campaigns",
        "Allows building a care-gap cohort and placing outbound check-in calls",
        PermissionContext.FACILITY,
        CARELOOP_OPERATIONAL_ROLES,
    )
    can_view_careloop_draft = Permission(
        "Can view CareLoop check-in drafts",
        "Allows reading the review queue and the contents of a drafted plan",
        PermissionContext.FACILITY,
        CARELOOP_OPERATIONAL_ROLES,
    )
    can_approve_careloop_draft = Permission(
        "Can approve CareLoop check-in drafts",
        "Allows approving a drafted plan, which writes observations and "
        "medication requests to the patient's chart",
        PermissionContext.FACILITY,
        CARELOOP_APPROVER_ROLES,
    )


# Must run at import time: core builds its role-permission enum from whatever
# has registered, so deferring this into a function would silently lose the
# permissions. See constraint C6.
PermissionController.register_permission_handler(CareloopPermissions)
