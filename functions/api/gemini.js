export async function onRequest(context) {
  // 💡 1. 허용할 도메인 목록
  const allowedOrigins = [
    "https://k-patent-workspace.pages.dev",
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

  // 🔥 수정된 구글 File API 고속 업로드 헬퍼 함수
async function uploadToGemini(fileData, apiKey) {
  // 1. 무거운 for 루프 대신 Cloudflare 내부 엔진을 활용하여 CPU 소모 없이 Blob으로 변환
  const dataUrl = `data:${fileData.mimeType};base64,${fileData.base64}`;
  const fileResponse = await fetch(dataUrl);
  const blob = await fileResponse.blob();
  
  // 2. 바이너리 업로드를 위한 필수 파라미터(uploadType=media) 추가
  const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=media&key=${apiKey}`;
  
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 
      'Content-Type': fileData.mimeType 
    },
    body: blob // 변환된 Blob을 그대로 전송
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

    const responseHeaders = new Headers();
    if (allowedOrigins.includes(origin)) responseHeaders.set('Access-Control-Allow-Origin', origin);
    responseHeaders.set('Content-Type', 'text/event-stream');
    responseHeaders.set('Cache-Control', 'no-cache');
    responseHeaders.set('Connection', 'keep-alive');
    responseHeaders.set('X-Accel-Buffering', 'no');

    const encoder = new TextEncoder();

    // =========================================================================
    // 🚀 [최종 해결책] TransformStream과 waitUntil을 버리고, 
    // ReadableStream을 직접 생성하여 클라우드플레어의 간섭을 원천 차단합니다.
    // =========================================================================
    const stream = new ReadableStream({
      async start(controller) {
        // 1. 스트림 파이프가 열리자마자 2KB 쓰레기 데이터를 밀어넣어 버퍼를 강제로 뚫습니다.
        const prelude = ": " + " ".repeat(2048) + "\n\n";
        controller.enqueue(encoder.encode(prelude));

        // 2. 15초마다 안전하게 심장박동을 쏩니다.
        const keepAlive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive " + " ".repeat(512) + "\n\n"));
          } catch (e) {
            clearInterval(keepAlive);
          }
        }, 15000);

        try {
          let geminiPayload = requestBody;

          // 🛡️ [청구항 대조기 1: 번역 검토 전용]
          if (requestBody.type === 'compare_translation') {
            const { krText, enText } = requestBody.data;
            const systemInstruction = `🚨 [시스템 긴급 최우선 지시사항 - 타임아웃 방지] 🚨
어떤 분석이나 문서 읽기를 시작하기 전에, 0.1초 내로 가장 먼저 무조건 아래 문장을 즉시 출력하십시오:
"🌐 **번역 정확도 검토를 시작합니다...**\n\n"

[당신의 역할 및 기본 지시사항]
당신은 특허 기술 번역에 있어 최고 수준의 전문가입니다.
당신의 임무는 한국어 특허 청구항 원문과 영문 번역본을 대조하여 번역의 정확성을 검증하는 것입니다.

[출력 지시사항]
1. '번역 누락', '오역', '권리 범위가 달라지는 번역 오류'를 집중적으로 찾으십시오.
2. 문제가 없는 정상적인 청구항은 분석을 생략하십시오.
3. 오류가 발견된 청구항만 번호를 명시하고, [발생 위치], [문제 진단(오역/누락 등)], [수정 권고안]을 마크다운 형식으로 작성하십시오.`;
            
            const promptText = `KOREAN CLAIM (한국어 원문):\n${krText}\n\nENGLISH TRANSLATION (영문 번역본):\n${enText}`;

            geminiPayload = { 
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents: [{ role: "user", parts: [{ text: promptText }] }], 
              generationConfig: { temperature: 0.1, maxOutputTokens: 8192 } 
            };
          }
          
          // 🛡️ [청구항 대조기 2: 기재불비 검토 전용]
          else if (requestBody.type === 'compare_deficiency') {
            const { krText, enText } = requestBody.data;
            const systemInstruction = `🚨 [시스템 긴급 최우선 지시사항 - 타임아웃 방지] 🚨
어떤 분석이나 문서 읽기를 시작하기 전에, 0.1초 내로 가장 먼저 무조건 아래 문장을 즉시 출력하십시오:
"⚖️ **영문 기재불비 검토를 시작합니다...**\n\n"

[당신의 역할 및 기본 지시사항]
당신은 미국(USPTO) 특허 실무에 능통한 최고 수준의 전문가입니다.
당신의 임무는 영문 특허 청구항을 분석하여 '법적/논리적 기재불비' 요소를 검증하는 것입니다.

[출력 지시사항]
1. 영문 청구항 자체의 '선행사 불일치(Antecedent basis 결여)', '불명확성(Clarity/Indefiniteness, 35 U.S.C 112)', '다중종속항 형식 오류' 등의 기재불비 요소를 찾으십시오.
2. 한국어 원문은 영문 청구항의 기술적 의도를 파악하기 위한 참고용으로만 사용하십시오.
3. 문제가 없는 정상적인 청구항은 분석을 생략하십시오.
4. 오류가 발견된 청구항만 번호를 명시하고, [발생 위치], [기재불비 근거(예: 선행사 누락)], [수정 권고안]을 마크다운 형식으로 작성하십시오.`;
            
            const promptText = `KOREAN CLAIM (의도 파악 참고용):\n${krText}\n\nENGLISH TRANSLATION (기재불비 검토 대상):\n${enText}`;

            geminiPayload = { 
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents: [{ role: "user", parts: [{ text: promptText }] }], 
              generationConfig: { temperature: 0.1, maxOutputTokens: 8192 } 
            };
          }
          
         // 🛡️ [의견서 생성기]
else if (requestBody.type === 'draft') {
  const { originalContext, amendmentContext, userDraftResponse, userTemplate } = requestBody.data;
  
  const secretPrompt = `🚨 [시스템 긴급 최우선 지시사항 - 타임아웃 방지] 🚨
어떤 분석이나 문서 작성을 시작하기 전에, 0.1초 내로 가장 먼저 무조건 아래 문장을 즉시 출력하십시오:
"✍️ 제공된 문헌을 바탕으로 의견서 초안 작성을 시작합니다...\n\n"

[역할 및 목표]
당신은 KIPO(한국특허청) 양식과 특허 실무에 능통한 전문 특허 명세사입니다.
당신의 임무는 입력된 자료와 템플릿을 바탕으로 심사관의 거절이유를 극복하기 위한 '최종 특허 의견서/보정서 초안'을 작성하는 것입니다.

[작성 원칙 및 엄격한 제약 사항]
1. 템플릿 엄수: 제공된 [작성 템플릿]의 문체, 어조, 양식, 목차 구조를 완벽하게 유지하십시오.
2. 사용자 논리 보존: [대응 초안 (핵심 논리)]에 포함된 주장은 단 하나도 누락하지 않고 본문에 자연스럽게 녹여내십시오.
3. 명세서 다중 보정 히스토리 누적 파악 (가장 중요): 
   - 제공된 자료는 [최초 명세서], (존재할 경우) [과거 누적 보정 내역], 그리고 [현재 제출할 보정서(최신 DTA)] 순서로 구성됩니다.
   - [과거 누적 보정 내역]에는 여러 차례에 걸친 과거의 보정 이력이 시간 순서대로 섞여 있을 수 있습니다. AI는 이 흐름을 파악하여 권리범위가 어떻게 변화해왔는지 맥락을 이해해야 합니다.
   - 단, 최종적인 방어 논리 전개와 청구항의 기준 상태는 무조건 가장 마지막 단계인 [현재 제출할 보정서(최신 DTA)]를 엄격하게 따릅니다. 
   - [현재 제출할 보정서]에 기재되지 않은(생략된) 청구항들은 직전 단계의 상태를 그대로 유지한 것으로 간주하십시오.
4. 청구항 임의 삭제/변경 절대 금지: 의견서 본문 작성 시, [현재 제출할 보정서(최신 DTA)]에 기재된 모든 청구항은 절대로 임의로 삭제하거나 내용을 변경하지 마시오.
5. 마크다운 볼드체 금지: 출력 결과물 전체에서 '**' 기호를 절대 사용하지 마십시오.
6. 부록(Appendix) 작성 의무: 의견서 본문 작성이 모두 끝난 후, 문서 맨 마지막에 구별되는 구분선(---)을 긋고 다음 두 가지 항목을 작성하십시오. 본문에서 지적하지 못한 문제점이나 훈수는 오직 이곳에만 기재해야 합니다.
   - [AI 보강 부분 및 추천 논리]: AI가 논리적 완성도를 높이기 위해 부득이하게 추가로 살을 붙인 부분과 추가적으로 보충되면 좋을 논리
   - [기재불비 및 문제점 점검]: [현재 제출할 보정서(최신 DTA)] 청구항의 중복 여부, 선행사 불일치, 삭제된 청구항 인용 등 문제가 발견되면, 본문을 임의로 고치지 말고 반드시 이 항목에서만 해당 문제점과 수정 권고안을 제안하십시오.

[특허청 통지서 원문]
${originalContext}

[명세서 및 누적 보정 내역]
${amendmentContext || '입력되지 않음'}

[대응 초안 (핵심 논리)]
${userDraftResponse}

[작성 템플릿]
${userTemplate}`;

  geminiPayload = { contents: [{ role: "user", parts: [{ text: secretPrompt }] }] };
}

          // 🛡️ [IDS 판별기]
          else if (requestBody.type === 'ids') {
            const { historyFiles, targetFiles, textInput } = requestBody.data;
            
            const uploadPromises = [];
            if (historyFiles) historyFiles.forEach(f => uploadPromises.push(uploadToGemini(f, apiKey).then(res => ({ ...res, type: 'history' }))));
            if (targetFiles) targetFiles.forEach(f => uploadPromises.push(uploadToGemini(f, apiKey).then(res => ({ ...res, type: 'target' }))));

            const uploadedFiles = await Promise.all(uploadPromises);
            
            let parts = [];
            uploadedFiles.forEach(f => {
              parts.push({ text: f.type === 'history' ? `\n--- [History (기존 제출 문헌) 파일명: ${f.name}] 시작 ---\n` : `\n--- [Target (신규 인용 문헌) 파일명: ${f.name}] 시작 ---\n` });
              parts.push({ fileData: { fileUri: f.fileUri, mimeType: f.mimeType } });
              parts.push({ text: f.type === 'history' ? `\n--- [History 파일명: ${f.name}] 끝 ---\n` : `\n--- [Target 파일명: ${f.name}] 끝 ---\n` });
            });

            parts.push({ 
              text: `너는 특허 정보 분석 전문가야. 위 제공된 문서들을 바탕으로 다음 [작업 순서]를 엄격히 준수하여 분석해.

[작업 순서]
1. 먼저, [Target] 문서들과 사용자가 수동으로 입력한 텍스트("${textInput || '입력 없음'}")만 샅샅이 뒤져서 '새롭게 인용된 선행기술문헌(특허번호 및 NPL)'을 모조리 추출해. (이것이 '기준 목록'이 된다. 절대로 History 문서에서 문헌을 먼저 추출하지 마라.)
2. 그 다음, 방금 만든 '기준 목록'의 각 문헌들이 [History] 문서들 내용 안에 이미 기재되어 있는지 하나하나 교차 검증(Cross-check)해.
3. 해당 문헌이 [History] 문서에서 하나라도 발견되었다면 상태를 "ALREADY_FILED"로, 어떤 History 문서에도 없다면 "NEW"로 판별해.

반드시 아래 JSON 배열 형식으로만 응답해 (마크다운 없이 순수 JSON만 출력):
[
  {
    "id": "문헌 번호 (예: US-11223344-B2, JP-2020-12345-A 등)",
    "type": "Patent" 혹은 "NPL",
    "status": "NEW" 혹은 "ALREADY_FILED",
    "source": "해당 문헌을 발견한 Target 문서명 또는 출처 페이지",
    "historyFile": "ALREADY_FILED인 경우 해당 문헌이 발견된 History 파일의 정확한 이름 (NEW인 경우에는 null) (History 파일이 여러개인 경우 '/'로 구분하여 표시하고, 그 중 발행날짜가 가장 빠른 것은 빨간색으로 강조표시할 것)"
  }
]` 
            });

            geminiPayload = { 
              contents: [{ role: "user", parts: parts }], 
              generationConfig: { responseMimeType: "application/json", temperature: 0.1 } 
            };
          }
          
          // 🛡️ [국가별 OA 논리 검토기]
          else if (requestBody.type === 'oa_review') {
            const { targetCountry, originalSpecification, officeAction, pendingClaims, amendedClaims, userDraftResponse } = requestBody.data;
            
            const cleanSpec = originalSpecification ? originalSpecification.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
            const cleanPending = pendingClaims ? pendingClaims.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
            const cleanAmended = amendedClaims ? amendedClaims.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';

            // 💡 프롬프트 다이어트 & 마크다운 스트리밍 적용
            const systemInstruction = `[최우선 지시사항]
네트워크 타임아웃 방지를 위해 무조건 다음 문장을 0.1초 내로 가장 먼저 출력할 것:
"💡 **${targetCountry} 기준 AI 논리 검토를 시작합니다...**\n\n"

[역할 및 목표]
- 역할: ${targetCountry} 특허 실무 전문가
- 목표: OA와 대응 초안 대조: 방어논리 누락, 불일치, 기재불비 검토

[검토 지침]
1. 누락 검증: OA 지적 사항 중 대응 초안에서 누락된 논리가 있는지 확인. 이때, 종속항에 대한 진보성 논리 판단은 제외.
2. 논리 일치: 보정 후 청구항과 대응 초안의 주장이 상충되지 않는지 확인. 
3. 기재불비: 보정 후 청구항의 명확성 결여 및 청구항 내용 상충 여부, 신규사항 추가(New Matter) 등 검토. 이때, ${targetCountry} 국가별 특유한 제도를 반영할 것. 
 - '보정 후 청구항'에 누락된 항은 '계류 중 청구항'과 동일시하여 전체 기준 판단
 - 신규사항: CN/EP 엄격 판단, KR/US/JP 명세서 도출 시 허용 적용

[출력 형식 - 반드시 마크다운으로 작성]
각 항목별로 문제점과 제안을 작성하고, 문제가 없으면 "✅ 특이사항 없음" 기재.
### 1. ⚠️ 누락된 대응 논리
### 2. 🚨 청구항-논리 불일치
### 3. 📝 기재불비 및 신규사항 추가`; //

            let parts = [
              { text: `[분석 자료]\n- 대상 국가: ${targetCountry}\n- 최초명세서: ${cleanSpec}\n- 계류중 청구항: ${cleanPending}\n- 보정 후 청구항: ${cleanAmended}\n- 대응 논리: ${userDraftResponse}` }
            ];

            if (officeAction) {
              const uploadedOA = await uploadToGemini(officeAction, apiKey);
              parts.push({ fileData: { fileUri: uploadedOA.fileUri, mimeType: uploadedOA.mimeType } });
              parts.push({ text: `[거절이유 / 통지서 원문 파일: ${uploadedOA.name}]` });
            }

            geminiPayload = { 
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents: [{ role: "user", parts: parts }], 
              // 🚨 JSON 설정 제거! 일반 텍스트 스트리밍으로 전송
              generationConfig: { temperature: 0.2, maxOutputTokens: 8192 } 
            };
          }

// 🛡️ [특허 검색식 도출기]
          else if (requestBody.type === 'search_query') {
            const { files, selectedFields } = requestBody.data;
            
            const uploadPromises = files.map(f => uploadToGemini(f, apiKey));
            const uploadedFiles = await Promise.all(uploadPromises);

            let parts = [];
            uploadedFiles.forEach(f => {
              parts.push({ fileData: { fileUri: f.fileUri, mimeType: f.mimeType } });
              parts.push({ text: `\n--- [참고 특허 문헌 파일명: ${f.name}] ---\n` });
            });

            const fieldsStr = selectedFields.join(', ');
            const exampleStr = selectedFields.map(f => `${f}:(...)`).join(' AND ');

            const systemInstruction = `🚨 [시스템 긴급 최우선 지시사항 - 타임아웃 방지] 🚨
어떤 분석이나 문서 읽기를 시작하기 전에, 0.1초 내로 가장 먼저 무조건 아래 문장을 즉시 출력하십시오:
"🔍 **선택된 필드(${fieldsStr}) 기반 특허 검색식 도출을 시작합니다...**\n\n"

[역할 및 목적]
당신은 특허 검색식 작성 최고 전문가입니다. 첨부된 특허 문헌들을 모두 노이즈 없이 도출해 내되, 반드시 '허용된 필드 연산자'만을 사용하여 넓은/중간/좁은 범위의 3가지 검색식을 작성해야 합니다.

[검색식 작성 8대 규칙]
1. 허용 필드 제한: 사용자가 선택한 [${fieldsStr}] 필드 이외에는 절대 사용 불가.
2. 필드 간 결합 (AND): 필드 연산자 사이는 반드시 AND로만 결합 (예: ${exampleStr}). 필드 간 OR 결합은 절대 금지.
3. 괄호 내 OR 공백 대체: 키워드가 동일한 성격인 괄호 안에서는 AND 연산자를 금지하며, OR 연산자는 기재하지 말고 무조건 '띄어쓰기(공백)'로 대체하세요. 단, 성격이 다른 키워드 그룹의 괄호 간에는 AND를 사용할 수 있습니다.
4. 인접 연산자 (N/n) 엄격 제한: 노이즈가 우려되거나 키워드 간 위치가 가까운 경우 N/n(n은 2~7)을 활용하되, "N/n"을 꼬리를 물고 연속으로 체인 결합하지 마세요. (나쁜 예: A N/5 B N/5 C / 좋은 예: (A N/5 B) AND C). "/" 기호 생략 금지.
5. 구문 검색 (""): 띄어쓰기가 포함된 복합 명사는 반드시 큰따옴표("")로 묶어 검색. 범위가 너무 좁아지면 N/n 연산자로 우회할 것.
6. 💡 유사어 극대화 및 [1음절 한글 키워드 제어]: 
   - 텍스트 필드(TAC, DSC, CLA)는 반드시 영/한 쌍(Pair)을 이루며, 외래어 음역 표기와 문맥상 동의어까지 최대한 묶으세요. (예: ("engine stall" "엔진 정지" "엔진 스톨" "시동 꺼짐"))
   - 🚨 1음절 한글 단어는 노이즈가 매우 심하므로 키워드로서 사용을 금지하고, 2음절 이상의 동의어로 대체하거나, 발생 가능한 주요 조사를 모두 붙인 형태들을 공백(OR)으로 묶어서 사용하세요. (예: ("망이" "망은" "망을" "망에" "망의" "망으로"))
   - 한글 와일드카드(*)는 2음절 이상 명사에만 부착 허용. (동사 배제)
7. 고유 식별자 규칙: AP(출원인)는 영/한 쌍 규칙 예외로 정확한 기업명만 기재. AD(출원일)는 AD:(YYYYMMDD~YYYYMMDD), IPC는 IPC:(분류기호) 형식 기재.
8. 🚨 필드 스코프(Scope) 및 괄호 무결성: 모든 검색 키워드와 내부 연산은 반드시 해당 필드 연산자의 가장 바깥쪽 괄호 안에 완벽하게 포함되어야 합니다. (좋은 예: DSC:((A N/5 B) AND C)). 괄호의 짝이 정확한지 검증하세요.

[출력 형식 - 반드시 마크다운 준수 및 목차 누락 금지]
### 1. 🌊 넓은 범위 검색식 (Broad)
\`\`\`text
(여유 있는 N/n 거리, 폭넓은 유사어/동의어 적극 반영)
\`\`\`
### 2. 🎯 중간 범위 검색식 (Medium)
\`\`\`text
(적절한 유사어/동의어, N/n 거리 중간 수준 조절)
\`\`\`
### 3. 📌 좁은 범위 검색식 (Narrow)
\`\`\`text
(유사어 확장 최소화, N/n 거리 타이트하게 제한)
\`\`\`
### 4. 💡 검색식 구성 논리 및 범위별 차이점
(Broad, Medium, Narrow 검색식 간의 인접 연산자 거리 및 유사어 확장 수준 차이점 해설)

### 5. 📍 키워드 도출 근거 및 문헌 내 위치 (필수 출력)
(검색식에 사용된 핵심 키워드들이 각 첨부 문헌의 명칭, 청구항 제O항, 상세한 설명의 어느 문맥에서 도출되었는지 그 실제 위치와 원문을 구체적으로 명시할 것)`;

            parts.push({ text: "위 규칙과 출력 형식을 완벽하게 반영하여 첨부된 문헌들을 찾아낼 수 있는 3단계 범위의 검색식을 도출해 주세요." });

            geminiPayload = { 
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents: [{ role: "user", parts: parts }], 
              generationConfig: { temperature: 0.1, maxOutputTokens: 8192 } 
            };
          }
          
           // 🚀 구글 제미나이 본 요청 시작
          const fallbackModel = requestBody.type === 'ids' ? "gemini-3.1-pro-preview" : "gemini-2.5-pro";
const targetModel = requestBody.model || fallbackModel;
const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent?alt=sse&key=${apiKey}`;
          let googleResponse;
          const maxRetries = 2; // 최대 2번 더 재시도 (총 3번 호출)
          
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            googleResponse = await fetch(googleUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(geminiPayload) 
            });

            // 503(과부하) 에러가 아니거나, 요청이 성공했다면 루프 탈출
            if (googleResponse.ok || googleResponse.status !== 503) {
              break;
            }

            // 503 에러이고 아직 재시도 기회가 남았다면 2초 대기 후 다시 찌르기
            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }

          if (!googleResponse.ok) {
            const errText = await googleResponse.text();
            // 에러 메시지를 JSON.stringify로 감싸서 안전하게 전송
            const safeErrorMsg = JSON.stringify(`API 에러 (${googleResponse.status}): ${errText}`);
            controller.enqueue(encoder.encode(`data: {"error": ${safeErrorMsg}}\n\n`));
            clearInterval(keepAlive);
            try { controller.close(); } catch(e) {}
            return;
          }

          // 정상적으로 응답이 오면 스트림을 연결합니다.
          const reader = googleResponse.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }

        } catch (err) {
          // 🔥 [수정된 부분] 백엔드 자체 에러도 안전하게 포장합니다!
          const safeErrorMsg = JSON.stringify(`백엔드 에러: ${err.message}`);
          controller.enqueue(encoder.encode(`data: {"error": ${safeErrorMsg}}\n\n`));
        } finally {
          clearInterval(keepAlive);
          try { controller.close(); } catch (e) {}
        }
      }
    });

    // =========================================================================
    // 💡 기다리지 않고 곧바로 stream을 반환합니다. 
    // ReadableStream 구조이기 때문에 Cloudflare가 즉시 200 OK 헤더를 프론트엔드로 쏩니다!
    // =========================================================================
    return new Response(stream, { status: 200, headers: responseHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: "초기화 에러: " + err.message }), { status: 500 });
  }
}
