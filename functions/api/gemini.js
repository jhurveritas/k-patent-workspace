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
### 3. 📝 기재불비 및 신규사항 추가`;

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
당신은 특허 검색식 작성 최고 전문가입니다. 첨부된 특허 문헌들을 모두 노이즈 없이 도출해 내되, 반드시 '허용된 필드 연산자'만을 사용하여 폭넓은 선행조사를 위한 '넓은 범위(Broad)'와 핵심 문헌 핀포인트 타격을 위한 '타겟 범위(Targeted)' 딱 2가지 검색식만 작성해야 합니다.
(필드연산자 의미는 다음과 같습니다. TAC: 명칭 + 요약 + 전체청구항, CLA: 전체 청구항, DSC: 상세한 설명, AP: 출원인, AD: 출원일, IPC: 국제특허 분류)
(검색연산자 의미는 다음과 같습니다. A AND B: 순서에 관계없이 A와 B를 동시에 포함하고 있는 문헌을 검색함, A OR B: 순서에 관계없이 A 또는 B를 포함하고 있는 문헌을 검색함, A N/n B: 순서에 관계없이 A와 B사이에 단어가 n개 이하로 포함된 문헌을 검색함, A*: *는 한 단어 내에서 임의 길이 문자열을 대체함)

[검색식 작성 10대 규칙]
1. 허용 필드 제한: 사용자가 선택한 [${fieldsStr}] 필드 이외에는 절대 사용 불가.
2. 필드 간 결합 (AND): 필드 연산자 사이는 반드시 AND로만 결합 (예: ${exampleStr}). 필드 간 OR 결합은 절대 금지. 
3. 괄호 내 OR 공백 대체: 키워드가 동일한 성격인 괄호 안에서는 AND 연산자를 금지하며, OR 연산자는 기재하지 말고 무조건 '띄어쓰기(공백)'로 대체하세요. 단, 성격이 다른 키워드 그룹의 괄호 간에는 AND를 사용할 수 있습니다.
4. 대체문자 (*)사용 가이드: "*" 사용 시, 영문의 경우 과거형, 분사형, 현재진행형, 형용사 등으로의 단어형태 변경을 고려하여 원천적인 의미를 가지는 원형 단어에 붙여서 한 단어로 나타낼 것 (예: brak*, electr*, park* 등)
5. 인접 연산자 (N/n) 엄격 제한: 노이즈가 우려되거나 키워드 간 위치가 가까운 경우 N/n(여기서 n은 2~7이고, (A N/n B)와 같이 N/n을 활용한 식은 다음 연산자가 나오기 전에 괄호로 닫혀야함.)을 활용하되, "N/n"을 꼬리를 물고 연속으로 체인 결합하지 마세요. (나쁜 예: A N/5 B N/5 C / 좋은 예: ((A) N/5 (B)) AND C). "/" 기호 생략 금지.
6. 구문 검색 (""): 띄어쓰기가 포함된 복합 명사는 반드시 큰따옴표("")로 묶어 검색. 범위가 너무 좁아지면 N/n 연산자로 우회할 것.
7. 💡 [모든 1음절 한글 단어 절대 차단] 및 영/한 쌍(Pair) 매칭: 
   - 텍스트 필드(TAC, DSC, CLA)는 반드시 영문과 한글 쌍을 이루어야 합니다.
   - 🚨 [최우선 예외 규칙]: '폴', '핀', '망', '축', '홈', '휠', '랙', '봉' 등 **그 어떠한 1음절(한 글자) 한글 단어도 키워드로 사용하는 것을 절대 금지합니다.**
   - 👉 [해결책]: 2음절 이상의 복합명사(예: 고정홈, 휠부재)로 대체하거나, 대체가 불가능한 경우 **반드시 큰따옴표 안에 가능한 조사와 전치사를 결합한 모든 형태**로만 나열하세요. (절대 1음절 단어 그대로 사용 금지.)
   - (치명적 나쁜 예: groove 홈 휠 wheel / 완벽한 좋은 예: groove wheel "홈이" "홈은" "홈을" "홈에" "홈의" "홈으로" "휠이" "휠은" "휠을" "휠에" "휠의" "휠로")
8. 고유 식별자 규칙: AP(출원인)는 영/한 쌍 규칙 예외로 정확한 기업명만 기재. AD(출원일)는 AD:(YYYYMMDD~YYYYMMDD), IPC는 IPC:(분류기호) 형식 기재.
9. 🚨 필드 스코프(Scope) 무결성 보장: 모든 검색 키워드와 내부 연산(AND, OR, N/n)은 반드시 해당 필드 연산자의 가장 바깥쪽 괄호 안에 완벽하게 갇혀 있어야 하고, 필드 연산자 바로 다음에 오는 괄호는 해당 필드 연산자를 닫는 마지막 괄호와 한 쌍으로 대응되어야 합니다. (좋은 예: DSC:(((A A') N/5 (B B')) AND (C C')))
10. 🚨 [최종 검증 단계 - 매우 중요]: 검색식을 최종 출력하기 전에, 아래 사항을 확인하세요.
    - 괄호 안에 한글 1글자짜리 키워드(예: 홈, 휠, 축 등)가 존재하는지 반드시 스스로 검토하세요. 단 하나라도 발견된다면 규칙 6번의 [해결책]을 적용하여 조사가 붙은 형태로 무조건 수정 후 출력해야 합니다.
    - 또한, 검색식 2개(넓은 범위, 타겟 범위)를 별개로 검색했을 때, 각 검색식의 모든 필드 연산자 및 검색 연산자를 고려한 내용이 첨부된 모든 문헌 각각에 포함되는지 검증하세요. 단 한 검색식 내의 필드 연산자 및 검색 연산자도 어떤 하나의 문헌을 히팅하지 못하면, 다시 검색식을 작성해야 합니다.
 
[출력 형식 - 반드시 마크다운 준수 및 목차 누락 금지]
### 1. 🌊 넓은 범위 검색식 (Broad)
\`\`\`text
(여유 있는 N/n 거리, 폭넓은 유사어/동의어 적극 반영)
\`\`\`
### 2. 🎯 타겟 범위 검색식 (Targeted)
\`\`\`text
(유사어 확장 최소화, N/n 거리 타이트하게 제한하여 핵심 문헌 타격에 집중)
\`\`\`
### 3. 📍 키워드 도출 근거 및 문헌 내 위치 (필수 출력)
(검색식 2개 각각에 대해, 각 필드 연산자 내에서 검색연산자에 따른 내용이 첨부 문헌의 어느 부분에서 명시되었는지 원문상에서의 위치와 문구를 알려줄 것)`;

            parts.push({ text: "위 규칙과 출력 형식을 완벽하게 반영하여 첨부된 문헌들을 찾아낼 수 있는 2단계 범위의 검색식을 도출해 주세요." });

            geminiPayload = { 
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents: [{ role: "user", parts: parts }], 
              generationConfig: { temperature: 0.1, maxOutputTokens: 8192 } 
            };
          }

          // 🛡️ [신규: 국가별 OA 대응안 생성기 - 워드 표/볼드체 서식 100% 보존 버전]
          else if (requestBody.type === 'oa_generate') {
            const {
              targetCountry,
              originalSpecificationFile,
              originalSpecificationImages,
              originalSpecificationText,
              officeAction,
              pendingClaims,
              priorArtFiles,
              agentCommentFile,
              userTemplate,
              strategies,
              strategy,
              userNotes
            } = requestBody.data;

            const strategyMap = {
              'balanced': '종합 추천안 (독립항 최소 한정 보정안 도출 + 의견서 반박 논리 병행)',
              'argument_only': '무보정 의견서 반박안 (청구항 권리범위 유지를 위해 보정을 지양하고, 심사관의 인용문헌 해석/결합 오류 및 도면상 구조적 차이를 집중 타격)',
              'amendment_focus': '조기 등록을 위한 적극적 보정안 (종속항 병합 또는 최초명세서 실시예/도면의 구체적 구성을 독립항에 한정하여 선행문헌과 명확히 차별화)',
              'custom': `사용자 직접 지시사항 맞춤형 대응안 (지시사항: "${userNotes || '별도 지시사항 참조'}")`
            };

            const selectedList = Array.isArray(strategies) && strategies.length > 0
              ? strategies
              : [strategy || 'balanced'];

            const strategyDescriptions = selectedList
              .map((s, idx) => `[제${idx + 1}안] ${strategyMap[s] || s}`)
              .join('\n   ');

            const countryRuleMap = {
              'KR': '대한민국(KIPO): 특허법 제47조제2항(신규사항 추가 금지 - 최초 명세서 또는 도면에 기재된 사항의 범위 내 보정), 제29조제1항/제2항(신규성/진보성 - 구성의 곤란성 및 효과의 현저성 중심), 제42조제4항(기재불비) 기준을 적용할 것.',
              'US': '미국(USPTO): 35 U.S.C. 112(a)(Written Description - 명세서 및 도면 뒷받침), 35 U.S.C. 102/103(KSR 판례 및 MPEP 2141/2143에 따른 Teaching Away, 결합 동기 결여, 부당한 사후적 고찰(Impermissible Hindsight) 반박), 35 U.S.C. 112(b)(Indefiniteness) 기준을 적용할 것.',
              'EP': '유럽(EPO): Art. 123(2) EPC(초엄격 신규사항 판단 - Gold Standard: 명세서로부터 직접적이고 일의적으로(directly and unambiguously) 도출되는 구성만 보정 허용, 중간일반화(Intermediate generalisation) 절대 주의) 및 Art. 56 EPC(Problem-Solution Approach: 가장 가까운 선행기술(CPA) 선정 ➔ 차이점 도출 ➔ 객관적 기술적 과제 설정 ➔ 자명성 반박) 기준을 엄격히 적용할 것.',
              'JP': '일본(JPO): 특허법 제17조의2제3항(신규사항 추가 금지), 제29조제2항(인용발명의 기술적 사상 및 저해요인(阻害要因) 중심 반박), 제36조제6항(기재요건) 기준을 적용할 것.',
              'CN': '중국(CNIPA): 특허법 제33조(초엄격 신규사항 판단 - 문자 그대로 기재되거나 직접적·의심의 여지 없이 결정되는 내용만 보정 허용), 제22조제3항(진보성 3단계 판단법: 가장 가까운 선행기술 확정 ➔ 구별되는 기술적 특징 및 실제로 해결하는 기술적 문제 확정 ➔ 기술적 시사(Technical Enlightenment) 유무 판단) 기준을 적용할 것.'
            };
            const countryRule = countryRuleMap[targetCountry] || `${targetCountry} 특허법 및 심사기준을 엄격히 적용할 것.`;

            const systemInstruction = `🚨 [시스템 긴급 최우선 지시사항 - 타임아웃 방지] 🚨
어떤 분석이나 문서 읽기를 시작하기 전에, 0.1초 내로 가장 먼저 무조건 아래 문장을 즉시 출력하십시오:
"<p>✨ <strong>${targetCountry} 기준 맞춤형 OA 대응안(총 ${selectedList.length}개 방향) 도출을 시작합니다...</strong></p>"

[당신의 역할 및 목표]
당신은 ${targetCountry} 특허 실무에 정통한 최고 수준의 시니어 변리사입니다.
제공된 [거절이유 통지서], [본원 최초명세서 및 도면], [현재 계류중인 청구항], (첨부된 경우) [인용참증(선행문헌)] 및 [현지대리인 코멘트]를 종합적으로 정밀 분석하여, 심사관의 거절이유를 완벽하게 극복할 수 있는 실전 'OA 대응안'을 작성하십시오.

[핵심 분석 및 작성 지침]
1. 국가별 심사기준 엄수:
   - ${countryRule}
2. 도면 및 명세서 정밀 활용 (매우 중요):
   - 본원 명세서의 상세한 설명뿐만 아니라 **도면(도면 부호, 부재 간의 결합 관계, 형상, 배치, 신호 흐름 등)**과 선행문헌의 도면/구성을 시각적·기술적으로 비교하십시오.
   - 청구항 보정안을 제안할 때는 반드시 **본원 최초명세서의 어느 단락(예: 단락 [0035]) 또는 몇 번 도면(예: 도 3)에 보정 근거(Support)가 있는지 명확히 기재**하여 신규사항 추가(New Matter) 리스크를 원천 차단하십시오.
3. 🔥 현지대리인 코멘트 및 현지대리인 보정안의 '변경내용 추적' 완벽 반영 (첨부된 경우 매우 중요):
   - 현지대리인 코멘트 문서가 제공된 경우, 현지대리인이 제안한 보정안과 분석 의견을 면밀히 검토하여 대응안에 포함하십시오.
   - 특히 **현지대리인이 제안한 청구항 보정안(Word 변경내용 추적으로 추출된 \`<ins>\`, \`<del>\` 태그 또는 PDF 내의 밑줄/취소선/대괄호 삭제 표시 등)을 대응안에 기재하거나 인용할 때도, 반드시 계류중인 청구항 대비 삭제된 부분은 \`<del>삭제된 텍스트</del>\`로, 추가/변경된 부분은 \`<ins>추가된 텍스트</ins>\` 태그로 감싸서 변경내용 추적이 동일하게 나타나도록 작성**하십시오!
4. 복수 대응 방향성(전략) 완벽 구현:
   - 사용자가 요청한 아래 ${selectedList.length}가지 대응 방향을 **누락 없이 각각 명확히 구분([제1안], [제2안] 등)하여** 구체적인 보정청구항(필요시)과 반박 논리를 제시하십시오:
   ${strategyDescriptions}
   ${userNotes ? `- 사용자 직접 추가 지시사항("${userNotes}")을 최우선으로 충실히 반영하십시오.` : ''}
5. 🔥 모든 청구항 보정사항(AI 추천 보정안 & 현지대리인 보정안 모두) '변경내용 추적(Track Changes)' 표시 의무:
   - 문서 내에 등장하는 모든 보정 후 청구항(Amended Claims)은 현재 계류중인 청구항 원문을 기준으로 **삭제되는 부분은 반드시 \`<del>삭제된 텍스트</del>\` 태그(빨간색 취소선/삭제 추적)로 감싸고, 새롭게 추가되거나 한정되는 부분은 반드시 \`<ins>추가된 텍스트</ins>\` 태그(파란색 굵은 밑줄/삽입 추적)로 감싸서** 한눈에 변경사항이 비교되도록 작성하십시오!
   - 종속항을 독립항에 병합하는 경우에도 병합으로 인해 삭제 처리되는 종속항은 \`<del>【청구항 3】 (삭제)</del>\` 형태로 명시하십시오.
6. 🔥 워드 양식(HTML 표/셀 배경색/정렬/볼드체 구조) 100% 완벽 복제 지침:
   ${userTemplate ? `- 사용자가 업로드한 [대응안 워드 양식(HTML 구조)]이 아래에 제공됩니다.
   - 당신의 출력물은 반드시 **순수 HTML 형식(코드블록 \`\`\`html 없이 바로 태그 출력)**이어야 합니다.
   - 제공된 [대응안 워드 양식]에 포함된 **모든 표(\`<table>\`), 행(\`<tr>\`), 셀(\`<td>\` 및 \`colspan\`, \`rowspan\`, \`style="background-color:..."\`, \`text-align\`), 볼드체(\`<strong>\`), 밑줄(\`<u>\`), 문단(\`<p>\`)의 inline style과 태그 구조를 단 하나도 생략하거나 바꾸지 말고 100% 똑같이 유지**하십시오!
   - 양식의 표 안에 있는 예시 내용이나 빈칸만 이번 사건의 실제 분석 데이터로 교체하여 채워 넣으십시오.` 
   : `- 별도의 양식이 첨부되지 않았으므로, Word 문서로 변환 시 가독성이 뛰어나도록 **순수 HTML 태그(\`<h3>\`, \`<p>\`, \`<table>\`, \`<tr>\`, \`<th>\`, \`<td>\`, \`<strong>\`, \`<ins>\`, \`<del>\`)**를 사용하여 아래 목차로 작성하십시오 (코드블록 \`\`\`html 사용 금지):
   <h3>1. 거절이유 요약 및 인용문헌 현황</h3> (표 \`<table>\` 형식으로 정리)
   <h3>2. 본원발명과 인용발명(D1, D2 등)의 핵심 구성 및 도면 대비 분석</h3> (표 \`<table>\` 형식으로 대비)
   <h3>3. 맞춤형 OA 대응 방안 (${selectedList.length > 1 ? '제1안 ~ 제' + selectedList.length + '안' : '추천 보정안 및 보정 근거'})</h3> (현지대리인 보정안 및 AI 보정안의 전/후 대비표 \`<table>\` 포함, 모든 보정 후 청구항 내 삭제는 \`<del>\`, 추가는 \`<ins>\` 태그 필수 적용)
   <h3>4. 거절이유 극복을 위한 핵심 반박 논리</h3>
   <h3>5. 실무자 종합 의견 및 후속 절차 가이드</h3>`}`;

            let parts = [];
            const uploadTasks = [];

            if (officeAction && officeAction.base64) {
              uploadTasks.push(
                uploadToGemini(officeAction, apiKey).then(res => ({ roleType: 'oa', ...res }))
              );
            }

            if (originalSpecificationFile && originalSpecificationFile.base64 && originalSpecificationFile.mimeType === 'application/pdf') {
              uploadTasks.push(
                uploadToGemini(originalSpecificationFile, apiKey).then(res => ({ roleType: 'spec_pdf', ...res }))
              );
            }

            if (Array.isArray(originalSpecificationImages) && originalSpecificationImages.length > 0) {
              originalSpecificationImages.slice(0, 15).forEach(img => {
                uploadTasks.push(
                  uploadToGemini(img, apiKey).then(res => ({ roleType: 'spec_img', ...res }))
                );
              });
            }

            if (Array.isArray(priorArtFiles) && priorArtFiles.length > 0) {
              priorArtFiles.forEach((pf, idx) => {
                if (pf && pf.base64) {
                  uploadTasks.push(
                    uploadToGemini(pf, apiKey).then(res => ({ roleType: 'prior_art', index: idx + 1, ...res }))
                  );
                }
              });
            }

            if (agentCommentFile && agentCommentFile.base64 && agentCommentFile.mimeType === 'application/pdf') {
              uploadTasks.push(
                uploadToGemini(agentCommentFile, apiKey).then(res => ({ roleType: 'agent_pdf', ...res }))
              );
            }

            const uploadedAssets = await Promise.all(uploadTasks);

            uploadedAssets.filter(a => a.roleType === 'oa').forEach(a => {
              parts.push({ text: `\n--- [거절이유 통지서(OA) 원문 파일: ${a.name}] 시작 ---\n` });
              parts.push({ fileData: { fileUri: a.fileUri, mimeType: a.mimeType } });
              parts.push({ text: `\n--- [거절이유 통지서(OA) 원문 파일] 끝 ---\n` });
            });

            uploadedAssets.filter(a => a.roleType === 'agent_pdf').forEach(a => {
              parts.push({ text: `\n--- [현지대리인 코멘트 / 검토의견서 파일: ${a.name}] 시작 ---\n` });
              parts.push({ fileData: { fileUri: a.fileUri, mimeType: a.mimeType } });
              parts.push({ text: `\n--- [현지대리인 코멘트 / 검토의견서 파일] 끝 ---\n` });
            });

            uploadedAssets.filter(a => a.roleType === 'spec_pdf').forEach(a => {
              parts.push({ text: `\n--- [본원 최초명세서 및 도면 원본(PDF): ${a.name}] 시작 ---\n` });
              parts.push({ fileData: { fileUri: a.fileUri, mimeType: a.mimeType } });
              parts.push({ text: `\n--- [본원 최초명세서 및 도면 원본(PDF)] 끝 ---\n` });
            });

            const specImgs = uploadedAssets.filter(a => a.roleType === 'spec_img');
            if (specImgs.length > 0) {
              parts.push({ text: `\n--- [본원 최초명세서 내 첨부 도면 이미지 (${specImgs.length}개)] 시작 ---\n` });
              specImgs.forEach(img => {
                parts.push({ fileData: { fileUri: img.fileUri, mimeType: img.mimeType } });
              });
              parts.push({ text: `\n--- [본원 최초명세서 내 첨부 도면 이미지] 끝 ---\n` });
            }

            uploadedAssets.filter(a => a.roleType === 'prior_art').forEach(a => {
              parts.push({ text: `\n--- [인용문헌/선행문헌 D${a.index} 파일: ${a.name}] 시작 ---\n` });
              parts.push({ fileData: { fileUri: a.fileUri, mimeType: a.mimeType } });
              parts.push({ text: `\n--- [인용문헌/선행문헌 D${a.index}] 끝 ---\n` });
            });

            const cleanSpecText = originalSpecificationText
              ? originalSpecificationText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
              : '';
            const cleanPendingClaims = pendingClaims
              ? pendingClaims.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
              : '';

            let userPrompt = `[OA 대응안 생성 요청 자료]
- 대상 국가: ${targetCountry}
- 요청된 대응 방안 목록 (복수 선택됨):
   ${strategyDescriptions}
- 사용자 직접 추가 지시사항: ${userNotes || '없음'}

[현재 계류중인 청구항 (심사 대상 청구항)]
${cleanPendingClaims}
`;

            if (agentCommentFile && agentCommentFile.extractedText) {
              userPrompt += `\n[현지대리인 코멘트 / 검토의견서 (${agentCommentFile.name})]\n${agentCommentFile.extractedText}\n`;
            }

            if (cleanSpecText) {
              userPrompt += `\n[본원 최초명세서 텍스트 (보정 근거 탐색용)]\n${cleanSpecText}\n`;
            }

            if (userTemplate && userTemplate.trim()) {
              userPrompt += `\n[사용자가 지정한 대응안 워드 양식 (HTML 구조 - 표 <table>, 셀 병합 colspan/rowspan, 볼드체 <strong> 등 모든 태그 구조를 그대로 복제하여 안의 내용만 채워 넣을 것!)]\n${userTemplate.trim()}\n`;
            }

            parts.push({ text: userPrompt });

            geminiPayload = {
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents: [{ role: "user", parts: parts }],
              generationConfig: { temperature: 0.15, maxOutputTokens: 65536 }
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
