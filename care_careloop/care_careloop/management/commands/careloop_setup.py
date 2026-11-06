"""Idempotent setup for CareLoop: service account, questionnaires, facility grants.

Run once per deployment, and again after any change to a condition module's
instrument. Safe to re-run: questionnaires are updated in place, keeping their
slug and their deterministic question ids so historical responses stay readable.

    manage.py careloop_setup
    manage.py careloop_setup --facility <facility-uuid>
    manage.py careloop_setup --organization <organization-uuid>
"""

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from care.emr.models.organization import Organization
from care.facility.models.facility import Facility

from care_careloop.clinical import list_modules
from care_careloop.services.questionnaire import (
    questionnaire_slug,
    register_questionnaire,
    total_link_id,
)
from care_careloop.services.service_account import (
    ensure_service_account,
    grant_facility_access,
)


class Command(BaseCommand):
    help = "Set up CareLoop's service account and instrument questionnaires."

    def add_arguments(self, parser):
        parser.add_argument(
            "--organization",
            help=(
                "Organization (external id) the questionnaires are attached to. "
                "This controls who can see them. Defaults to the first govt "
                "organization."
            ),
        )
        parser.add_argument(
            "--facility",
            help=(
                "Facility (external id) to grant the service account access to. "
                "Required before it can submit answers for that facility's patients."
            ),
        )

    def _resolve_organization(self, external_id: str | None) -> Organization:
        if external_id:
            org = Organization.objects.filter(external_id=external_id).first()
            if org is None:
                raise CommandError(f"No organization with external_id {external_id}")
            return org
        org = Organization.objects.filter(org_type="govt").order_by("id").first()
        if org is None:
            raise CommandError(
                "No govt organization found. Pass --organization explicitly."
            )
        return org

    @transaction.atomic
    def handle(self, *args, **options):
        account, account_created = ensure_service_account()
        self.stdout.write(
            self.style.SUCCESS(
                f"{'created' if account_created else 'found'} service account "
                f"'{account.username}' (is_service_account={account.is_service_account})"
            )
        )

        organization = self._resolve_organization(options.get("organization"))
        self.stdout.write(f"attaching questionnaires to organization: {organization.name}")

        for module in list_modules():
            questionnaire, created = register_questionnaire(module, organization, account)
            self.stdout.write(
                self.style.SUCCESS(
                    f"  {'created' if created else 'updated'} {questionnaire_slug(module)}"
                )
            )
            codes = [q["code"]["code"] for q in questionnaire.questions if q.get("code")]
            self.stdout.write(
                f"      subject_type={questionnaire.subject_type} "
                f"questions={len(questionnaire.questions)} "
                f"total_link_id={total_link_id(module)}"
            )
            self.stdout.write(f"      LOINC codes: {', '.join(codes)}")

        facility_id = options.get("facility")
        if facility_id:
            facility = Facility.objects.filter(external_id=facility_id).first()
            if facility is None:
                raise CommandError(f"No facility with external_id {facility_id}")
            granted = grant_facility_access(account, facility)
            self.stdout.write(
                self.style.SUCCESS(
                    f"{'granted' if granted else 'already had'} Staff role for "
                    f"'{account.username}' at {facility.name}"
                )
            )
        else:
            self.stdout.write(
                self.style.WARNING(
                    "No --facility given. The service account cannot submit answers "
                    "until it holds a role at the facility whose patients it calls "
                    "(see services/service_account.py)."
                )
            )
