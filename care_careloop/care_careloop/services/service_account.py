"""The CareLoop service account: the non-human principal that records answers.

Provenance, not convenience. Spike V2 confirmed that `handle_response` stamps
``created_by`` and ``data_entered_by`` from whoever submits, so submitting as the
reviewing clinician would put their name on answers a voice agent collected —
a statement that they asked the questions. CARE has ``User.is_service_account``
precisely for this, so the agent gets its own identity and the clinician is
recorded separately as the approver (constraint C5).

Spike V2 also showed what the account *needs*:
``can_submit_encounter_questionnaire`` resolves through ``find_roles_on_patient``,
which looks at roles held in the patient's organizations or the encounter's
facility organizations — a global permission is not enough. So the account is
granted a role **per facility**, which conveniently also scopes it: the agent
can only record answers for facilities it has been added to.

The role granted is ``Staff``, the least-privileged role that carries the
permission. The agent records answers; it does not prescribe.
"""

from __future__ import annotations

from django.db import transaction

from care.emr.models.organization import FacilityOrganization, FacilityOrganizationUser
from care.facility.models.facility import Facility
from care.security.models import RoleModel
from care.security.roles.role import STAFF_ROLE
from care.users.models import User

from care_careloop.settings import plugin_settings


def service_account_username() -> str:
    return plugin_settings.CARELOOP_SERVICE_ACCOUNT_USERNAME


@transaction.atomic
def ensure_service_account() -> tuple[User, bool]:
    """Get or create the CareLoop service account.

    It is unusable as a login: ``set_unusable_password`` means there is no
    credential to steal or leak, and nothing in CareLoop authenticates as it
    over HTTP — it is only ever passed in-process to CARE's service layer.
    """
    username = service_account_username()
    user = User.objects.filter(username=username).first()
    if user:
        # Repair the flag if someone created the row by hand.
        if not user.is_service_account:
            user.is_service_account = True
            user.save(update_fields=["is_service_account"])
        return user, False

    user = User(
        username=username,
        email="",
        first_name="CareLoop",
        last_name="Voice Agent",
        user_type="staff",
        is_service_account=True,
        is_active=True,
        is_staff=False,
        is_superuser=False,
    )
    user.set_unusable_password()
    user.save()
    return user, True


@transaction.atomic
def grant_facility_access(user: User, facility: Facility) -> bool:
    """Give the service account a Staff role in the facility's root organization.

    Returns True when the grant was newly created.

    Without this, questionnaire submission fails with "Permission Denied to
    submit patient questionnaire" even though the user exists and the
    questionnaire is registered — the failure spike V2 hit before taking a
    superuser shortcut.
    """
    root = (
        FacilityOrganization.objects.filter(facility=facility, org_type="root")
        .order_by("id")
        .first()
    )
    if root is None:
        # Fall back to any organization attached to the facility rather than
        # failing silently; a facility with none is a data problem worth raising.
        root = FacilityOrganization.objects.filter(facility=facility).order_by("id").first()
    if root is None:
        raise RuntimeError(
            f"Facility {facility.external_id} has no facility organization to grant a role in."
        )

    role = RoleModel.objects.filter(name=STAFF_ROLE.name).first()
    if role is None:
        raise RuntimeError(
            f"Role '{STAFF_ROLE.name}' is not present. Load CARE's role fixtures first."
        )

    _, created = FacilityOrganizationUser.objects.get_or_create(
        organization=root, user=user, defaults={"role": role}
    )
    return created
