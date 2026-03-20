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

  // 🔥 구글 File API 고속 업로드 헬퍼 함수
  async function uploadToGemini(fileData, apiKey) {
    const binaryString = atob(fileData.base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
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
    
    const data = await res.json();
    return { fileUri: data.file.uri, mimeType: fileData.mimeType, name: fileData.name };
  }

  try {
    const apiKey = context.env.GEMINI_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "API 키 없음" }), { status: 400 });

    const requestBody = await context.request.json();
    let geminiPayload = requestBody; 

   // 🛡️ [청구항 대조기] - 완벽한 JSON 스키마 적용
    if (requestBody.type === 'compare') {
      const { krText, enText } = requestBody.data;
      
      const systemInstruction = `
        당신은 한국 특허 실무와 글로벌(USPTO/EPO) 특허 표준을 모두 꿰뚫고 있는 세계 최고 수준의 특허 변리사 및 기술 번역 전문가입니다.
        당신의 임무는 한국어 특허 청구항의 영문 번역본을 분석하여 정확성, 법적 효력, 기술적 일관성을 검증하는 것입니다.

        분석 시 다음 사항에 집중하세요:
        1. 각 오류나 불일치가 발생하는 '위치'를 정확히 식별하십시오 (예: 전제부(Preamble), 구성요소 1, 특징부, 전이구 등).
        2. 법적 권리 범위 (Legal Scope): 영문 번역이 원본 한국어 청구항의 범위를 부당하게 넓히거나 좁히지 않았는가?
        3. 용어의 정확성 (Terminology): 기술 용어가 산업 표준 영문 용어로 정확하게 번역되었는가?
        4. 구조적 무결성: USPTO/EPO 표준 형식을 따르고 있는가?
        5. 완전성: 한국어 원문의 모든 한정 사항이 영문에 반영되었는가?

        중요: 
        - 'discrepancies' 배열 내의 각 항목은 청구항 내의 구체적인 '위치(locationIndicator)'를 포함해야 합니다.
        - 모든 분석 내용(summary, comment, suggestion, issue)은 한국어로 작성하십시오.
        - 한국인 전문가가 '어느 부분에서 어떤 문제가 발생했는지' 한눈에 알 수 있도록 위치 식별을 명확히 하십시오.
      `;

      const promptText = `KOREAN CLAIM (한국어 원문):\n${krText}\n\nENGLISH TRANSLATION (영문 번역본):\n${enText}`;

      geminiPayload = { 
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: promptText }] }], 
        generationConfig: { 
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              overallScore: { type: "NUMBER" },
              summary: { type: "STRING" },
              checks: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    category: { type: "STRING" },
                    status: { type: "STRING", enum: ["Pass", "Warning", "Fail"] },
                    comment: { type: "STRING" },
                    suggestion: { type: "STRING" }
                  },
                  required: ["category", "status", "comment"]
                }
              },
              discrepancies: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    locationIndicator: { type: "STRING" },
                    koreanSegment: { type: "STRING" },
                    englishSegment: { type: "STRING" },
                    issue: { type: "STRING" },
                    severity: { type: "STRING", enum: ["Low", "Medium", "High", "Critical"] },
                    recommendedFix: { type: "STRING" }
                  },
                  required: ["locationIndicator", "koreanSegment", "englishSegment", "issue", "severity", "recommendedFix"]
                }
              }
            },
            required: ["overallScore", "summary", "checks", "discrepancies"]
          }
        } 
      };
    }
    
    // 🛡️ [의견서 생성기]
    else if (requestBody.type === 'draft') {
      const { originalContext, amendmentContext, userDraftResponse, userTemplate } = requestBody.data;
      const secretPrompt = `너는 KIPO(한국특허청) 양식에 능통한 전문 특허 명세사야. 제공된 템플릿의 문체와 양식을 엄격하게 준수하여 아래 자료를 바탕으로 최종 특허 의견서/보정서를 작성해줘.\n\n[특허청 통지서 원문]\n${originalContext}\n\n[보정서 원문]\n${amendmentContext || '입력되지 않음'}\n\n[대응 초안 (핵심 논리)]\n${userDraftResponse}\n\n[작성 템플릿]\n${userTemplate}`;
      geminiPayload = { contents: [{ role: "user", parts: [{ text: secretPrompt }] }] };
    }

    // 🛡️ [IDS 판별기]
    else if (requestBody.type === 'ids') {
      const { historyFiles, targetFiles, textInput } = requestBody.data;
      let parts = [{ text: `너는 특허 정보 분석 전문가야. Target 문서(및 텍스트: ${textInput})에서 인용된 선행기술문헌(NPL, 특허문헌 등)을 모두 추출한 뒤, History 문서들에 이미 포함되어 있는지 교차 검증해줘. 반드시 아래 JSON 배열 형식으로만 응답해: [{ "id": "문헌 번호", "type": "Patent/NPL", "status": "NEW/ALREADY_FILED", "source": "Target 내 출처 페이지" }]` }];
      
      const uploadPromises = [];
      if (historyFiles) historyFiles.forEach(f => uploadPromises.push(uploadToGemini(f, apiKey).then(res => ({ ...res, type: 'history' }))));
      if (targetFiles) targetFiles.forEach(f => uploadPromises.push(uploadToGemini(f, apiKey).then(res => ({ ...res, type: 'target' }))));

      const uploadedFiles = await Promise.all(uploadPromises);
      uploadedFiles.forEach(f => {
        parts.push({ fileData: { fileUri: f.fileUri, mimeType: f.mimeType } });
        parts.push({ text: f.type === 'history' ? `[History 기존 제출 문헌: ${f.name}]` : `[Target 신규 분석 대상: ${f.name}]` });
      });

      geminiPayload = { contents: [{ role: "user", parts: parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.1 } };
    }
    
    // 🛡️ [국가별 OA 논리 검토기] (🔥 신규 추가됨)
    else if (requestBody.type === 'oa_review') {
      const { targetCountry, originalSpecification, officeAction, pendingClaims, amendedClaims, userDraftResponse } = requestBody.data;
      
      const prompt = `너는 ${targetCountry} 특허법 및 심사실무에 능통한 최고 수준의 특허 명세사야. 
      아래 제공된 자료들을 바탕으로 심사관의 거절이유를 극복하기 위한 논리의 타당성을 엄격하게 검토하고, 반드시 아래 JSON 형식으로만 응답해줘.
      
      [분석 자료]
      - 대상 국가: ${targetCountry}
      - 최초명세서: ${originalSpecification}
      - 계류중 청구항: ${pendingClaims}
      - 보정 후 청구항: ${amendedClaims}
      - 대응 초안(핵심 논리): ${userDraftResponse}
      
      [요구되는 JSON 응답 포맷 (반드시 지킬 것)]
      {
        "isComplete": boolean (완벽한 방어 논리인지 여부),
        "missingPoints": [{"point": "지적 사항 요약", "suggestion": "보완 제안 내용"}],
        "claimDiscrepancies": [{"issue": "불일치 문제점", "suggestion": "해결 제안 내용"}],
        "descriptionDeficiencies": [{"issue": "기재불비 문제점", "suggestion": "해결 제안 내용"}]
      }`;

      let parts = [{ text: prompt }];

      // 거절이유 통지서 PDF/문서가 있다면 업로드 후 프롬프트에 조립
      if (officeAction) {
        const uploadedOA = await uploadToGemini(officeAction, apiKey);
        parts.push({ fileData: { fileUri: uploadedOA.fileUri, mimeType: uploadedOA.mimeType } });
        parts.push({ text: `[거절이유 / 통지서 원문 파일: ${uploadedOA.name}]` });
      }

      geminiPayload = { contents: [{ role: "user", parts: parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } };
    }

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
