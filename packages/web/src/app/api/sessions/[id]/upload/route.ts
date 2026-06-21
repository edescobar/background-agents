import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await params;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "File too large (max 10 MB)" }, { status: 400 });
  }

  if (file.type && !ALLOWED_MIME_TYPES.has(file.type)) {
    return NextResponse.json({ error: "Unsupported image type" }, { status: 400 });
  }

  // Build a new FormData for the control-plane (adds artifactType)
  const cpForm = new FormData();
  cpForm.append("file", file);
  cpForm.append("artifactType", "image");

  try {
    // controlPlaneFetch detects FormData body and omits Content-Type: application/json
    // so the multipart/form-data boundary is set correctly by the runtime.
    const response = await controlPlaneFetch(`/sessions/${sessionId}/media`, {
      method: "POST",
      body: cpForm,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Upload to control-plane failed: ${errorText}`);
      return NextResponse.json({ error: "Upload failed" }, { status: response.status });
    }

    const result = await response.json();
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
