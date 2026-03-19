export async function onRequest(context) {
  // 💡 1. 허용할 도메인 목록
  const allowedOrigins = [
    "https://my-patent-pro.pages.dev", // 실제 도메인으로 변경하세요!
    "http://localhost:8788",
    "http://127.0.0.1:8788",
    "http://localhost:5500"
  ];

  const origin = context.request.headers.get("Origin");
  const isAllowedOrigin = allowedOrigins.includes(origin);

  // 💡 2. Preflight (OPTIONS 요청) 사전 차단 및 응답
  if (context.request.method === "OPTIONS") {
    if (isAllowedOrigin) {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      });
    } else {
      return new Response(null, { status: 403 }); 
    }
  }

  // 🔥 [핵심 추가] 구글 File API 고속 업로드 헬퍼 함수
  async function uploadToGemini(fileData, apiKey) {
    // 프론트에서 받은 Base64 텍스트를 실제 바이너리(파일)로 복원
    const binaryString = atob(fileData.base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    // 구글 클라우드 서버로 파일 직배송
    const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': fileData.mimeType },
      body: bytes.buffer
    });
    
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`File API 업로드 실패: ${errText}`);
    }
    
    // 업로드 성공 후 발급받은 URI(열쇠) 반환
    const data = await res.json();
    return { fileUri: data.file.uri, mimeType: fileData.mimeType, name: fileData.name };
  }

  try {
    const apiKey = context.env.GEMINI_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "API 키 없음" }), { status: 400 });

    const requestBody = await context.request.json();
    let geminiPayload = requestBody; 

    // 🛡️ [청구항 대조기]
    if (requestBody.type === 'compare') {
      const { krText, enText } = requestBody.data;
      const secretPrompt = `너는 전문 특허 번역가이자 명세사야. 아래 한국어 특허 청구항 원문과 영문 번역본을 교차 검증해서 다음 항목을 분석해줘:\n\n1. 누락되거나 잘못 번역된 구성요소\n2. 법적 권리 범위의 변동 가능성 (원문과 번역본 간의 괴리)\n3. 특허 용어(Terminology)의 적절성\n4. 종합적인 수정 제안\n\n[한국어 원문]\n${krText}\n\n[영문 번역본]\n${enText}`;
      
      geminiPayload = {
        contents: [{ role: "user", parts: [{ text: secretPrompt }] }],
        generationConfig: { temperature: 0.1 }
      };
    }
    
    // 🛡️ [의견서 생성기]
    else if (requestBody.type === 'draft') {
      const { originalContext, amendmentContext, userDraftResponse, userTemplate } = requestBody.data;
      
      const secretPrompt = `너는 KIPO(한국특허청) 양식에 능통한 전문 특허 명세사야. 제공된 템플릿의 문체와 양식을 엄격하게 준수하여 아래 자료를 바탕으로 최종 특허 의견서/보정서를 작성해줘.\n\n[특허청 통지서 원문]\n${originalContext}\n\n[보정서 원문]\n${amendmentContext || '입력되지 않음'}\n\n[대응 초안 (핵심 논리)]\n${userDraftResponse}\n\n[작성 템플릿]\n${userTemplate}`;
      
      geminiPayload = {
        contents: [{ role: "user", parts: [{ text: secretPrompt }] }]
      };
    }

    // 🛡️ [IDS 판별기] - 대용량 파일 업로드 로직 적용
    else if (requestBody.type === 'ids') {
      const { historyFiles, targetFiles, textInput } = requestBody.data;
      
      let parts = [{ text: `너는 특허 정보 분석 전문가야. Target 문서(및 텍스트: ${textInput})에서 인용된 선행기술문헌(NPL, 특허문헌 등)을 모두 추출한 뒤, History 문서들에 이미 포함되어 있는지 교차 검증해줘. 반드시 아래 JSON 배열 형식으로만 응답해: [{ "id": "문헌 번호(예: US 10,123,456 B2)", "type": "Patent/NPL", "status": "NEW/ALREADY_FILED", "source": "Target 내 출처 페이지/단락" }]` }];
      
      // 1단계: 구글 서버로 모든 PDF 병렬 고속 업로드
      const uploadPromises = [];
      if (historyFiles) {
        historyFiles.forEach(f => uploadPromises.push(uploadToGemini(f, apiKey).then(res => ({ ...res, type: 'history' }))));
      }
      if (targetFiles) {
        targetFiles.forEach(f => uploadPromises.push(uploadToGemini(f, apiKey).then(res => ({ ...res, type: 'target' }))));
      }

      // 업로드가 모두 끝날 때까지 대기
      const uploadedFiles = await Promise.all(uploadPromises);

      // 2단계: 발급받은 URI(열쇠)들을 프롬프트 부품(parts)에 조립
      uploadedFiles.forEach(f => {
        parts.push({ fileData: { fileUri: f.fileUri, mimeType: f.mimeType } });
        if (f.type === 'history') {
          parts.push({ text: `[History 기존 제출 문헌: ${f.name}]` });
        } else {
          parts.push({ text: `[Target 신규 분석 대상: ${f.name}]` });
        }
      });

      // 최종 프롬프트 패키징
      geminiPayload = {
        contents: [{ role: "user", parts: parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
      };
    }

    // 🚀 구글 제미나이 모델에 최종 질문(프롬프트) 전송
    const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse&key=${apiKey}`;
    const googleResponse = await fetch(googleUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiPayload) 
    });

    const response = new Response(googleResponse.body, googleResponse);
    if (isAllowedOrigin) response.headers.set('Access-Control-Allow-Origin', origin);
    return response;

  } catch (err) {
    return new Response(JSON.stringify({ error: "백엔드 에러: " + err.message }), { status: 500 });
  }
}
