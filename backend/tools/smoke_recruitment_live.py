"""Manual, paid end-to-end smoke with a synthetic resume; never runs in CI."""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def main() -> None:
    from fastapi.testclient import TestClient
    from shared import config  # noqa: F401 - loads the local ignored .env
    from main import app

    if not os.getenv("SILICONFLOW_API_KEY"):
        raise SystemExit("SILICONFLOW_API_KEY is required for the live smoke.")
    fixture = (BACKEND / "tests" / "fixtures" / "candidate.pdf").read_bytes()
    with tempfile.TemporaryDirectory(prefix="ttc-recruitment-smoke-") as directory:
        os.environ["RECRUITMENT_DATA_DIR"] = directory
        os.environ["HR_REGISTRATION_CODE"] = "synthetic-smoke-only-code"
        with TestClient(app) as client:
            def register(role: str, email: str) -> dict:
                payload = {"name": role, "email": email, "password": "synthetic-smoke-password",
                           "role": role}
                if role == "hr":
                    payload.update({"companyName": "Synthetic Test Company",
                                    "hrRegistrationCode": "synthetic-smoke-only-code"})
                response = client.post("/api/auth/register", json=payload)
                response.raise_for_status()
                return response.json()

            hr = register("hr", "smoke-hr@example.invalid")
            candidate = register("candidate", "smoke-candidate@example.invalid")
            hr_headers = {"Authorization": "Bearer " + hr["token"]}
            candidate_headers = {"Authorization": "Bearer " + candidate["token"]}
            job = client.post("/api/hr/jobs", headers=hr_headers, json={
                "title": "Frontend Engineer",
                "description": "Build React and TypeScript interfaces; explain front-end caching decisions, browser performance improvements, personal project contribution, collaboration, and measurable outcomes.",
            })
            job.raise_for_status()
            submitted = client.post("/api/applications", headers=candidate_headers,
                data={"jobId": job.json()["id"], "consent": "true"},
                files={"resume": ("candidate.pdf", fixture, "application/pdf")})
            submitted.raise_for_status()
            app_id = submitted.json()["application"]["id"]
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                detail = client.get(f"/api/hr/applications/{app_id}", headers=hr_headers)
                detail.raise_for_status()
                status = detail.json()["screeningStatus"]
                if status in ("completed", "failed"):
                    break
                time.sleep(0.3)
            else:
                raise SystemExit("Screening did not finish within 120 seconds.")
            if status != "completed":
                raise SystemExit("Screening failed: " + str(detail.json()["screeningError"]))
            safe = client.get(f"/api/applications/{app_id}", headers=candidate_headers)
            safe.raise_for_status()
            assert "screening" not in safe.json() and "matchScore" not in safe.json()
            invite = client.post(f"/api/hr/applications/{app_id}/review", headers=hr_headers,
                                 json={"decision": "invite", "notes": "Synthetic smoke test."})
            invite.raise_for_status()
            start = client.post(f"/api/applications/{app_id}/interview/start",
                                headers=candidate_headers)
            start.raise_for_status()
            assert start.json()["ticket"] and start.json()["code"]
            print("LIVE_SMOKE_OK", detail.json()["screeningMeta"]["model"],
                  safe.json()["status"], invite.json()["status"], "room-ready")


if __name__ == "__main__":
    main()
