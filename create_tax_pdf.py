#!/usr/bin/env python3
"""
KYN 세법 메커니즘 정리 PDF Generator
Uses NanumMyeongjo for Korean text support with reportlab
"""

import os
from datetime import datetime
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm, cm
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, KeepTogether, PageBreak
)
from reportlab.platypus.flowables import Flowable
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# ─── Font Registration ─────────────────────────────────────────────────────────
NANUM_PATH = (
    "/System/Library/AssetsV2/com_apple_MobileAsset_Font8/"
    "4c932c71d74fc9e4c1bd9cbf270374b0b3ee7519.asset/AssetData/NanumMyeongjo.ttc"
)

pdfmetrics.registerFont(TTFont("KorRegular", NANUM_PATH, subfontIndex=0))
pdfmetrics.registerFont(TTFont("KorBold",    NANUM_PATH, subfontIndex=1))
# subfontIndex=2 is ExtraBold — use as heavy bold
pdfmetrics.registerFont(TTFont("KorHeavy",   NANUM_PATH, subfontIndex=2))

# ─── Color Palette ─────────────────────────────────────────────────────────────
NAVY       = colors.HexColor("#1A2B4A")
TEAL       = colors.HexColor("#2E7D9C")
LIGHT_TEAL = colors.HexColor("#EBF5FA")
GOLD       = colors.HexColor("#C9971C")
LIGHT_GRAY = colors.HexColor("#F5F5F5")
MED_GRAY   = colors.HexColor("#888888")
DARK_GRAY  = colors.HexColor("#333333")
CODE_BG    = colors.HexColor("#F0F4F8")
CODE_BORDER= colors.HexColor("#CBD5E0")
LAW_COLOR  = colors.HexColor("#5A6A7E")
RED_ALERT  = colors.HexColor("#C0392B")

# ─── Page Setup ───────────────────────────────────────────────────────────────
PAGE_W, PAGE_H = A4
MARGIN_L = 2.2 * cm
MARGIN_R = 2.2 * cm
MARGIN_T = 2.5 * cm
MARGIN_B = 2.5 * cm
CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R

OUTPUT_PATH = "/Users/junseongkim/KYN/KYN_세법_메커니즘_정리.pdf"

# ─── Styles ───────────────────────────────────────────────────────────────────
def make_styles():
    s = {}

    s["doc_title"] = ParagraphStyle(
        "doc_title",
        fontName="KorBold",
        fontSize=22,
        leading=30,
        textColor=colors.white,
        alignment=TA_CENTER,
        spaceAfter=4,
    )
    s["doc_subtitle"] = ParagraphStyle(
        "doc_subtitle",
        fontName="KorRegular",
        fontSize=11,
        leading=16,
        textColor=colors.HexColor("#A8C4D8"),
        alignment=TA_CENTER,
    )
    s["section_title"] = ParagraphStyle(
        "section_title",
        fontName="KorBold",
        fontSize=13,
        leading=18,
        textColor=colors.white,
        alignment=TA_LEFT,
        leftIndent=4,
    )
    s["law_ref"] = ParagraphStyle(
        "law_ref",
        fontName="KorRegular",
        fontSize=9,
        leading=14,
        textColor=LAW_COLOR,
        leftIndent=8,
        spaceAfter=6,
    )
    s["body"] = ParagraphStyle(
        "body",
        fontName="KorRegular",
        fontSize=10,
        leading=16,
        textColor=DARK_GRAY,
        leftIndent=8,
        spaceAfter=4,
    )
    s["body_bold"] = ParagraphStyle(
        "body_bold",
        fontName="KorBold",
        fontSize=10,
        leading=16,
        textColor=DARK_GRAY,
        leftIndent=8,
    )
    s["code"] = ParagraphStyle(
        "code",
        fontName="Courier",
        fontSize=8.5,
        leading=13,
        textColor=colors.HexColor("#2D3748"),
        leftIndent=4,
        rightIndent=4,
    )
    s["label"] = ParagraphStyle(
        "label",
        fontName="KorBold",
        fontSize=9,
        leading=13,
        textColor=TEAL,
        spaceAfter=2,
    )
    s["footer"] = ParagraphStyle(
        "footer",
        fontName="KorRegular",
        fontSize=8,
        leading=12,
        textColor=MED_GRAY,
        alignment=TA_CENTER,
    )
    s["toc_title"] = ParagraphStyle(
        "toc_title",
        fontName="KorBold",
        fontSize=14,
        leading=20,
        textColor=NAVY,
        spaceAfter=8,
    )
    s["toc_item"] = ParagraphStyle(
        "toc_item",
        fontName="KorRegular",
        fontSize=10,
        leading=17,
        textColor=DARK_GRAY,
        leftIndent=6,
    )
    return s


# ─── Custom Flowables ──────────────────────────────────────────────────────────
class NavyHeader(Flowable):
    """Full-width dark navy header block for the first page."""
    def __init__(self, width, height=100):
        super().__init__()
        self.width = width
        self.height = height

    def draw(self):
        c = self.canv
        # Background
        c.setFillColor(NAVY)
        c.rect(0, 0, self.width, self.height, fill=1, stroke=0)
        # Gold accent line at bottom
        c.setFillColor(GOLD)
        c.rect(0, 0, self.width, 4, fill=1, stroke=0)


class SectionHeader(Flowable):
    """Colored section header banner."""
    def __init__(self, number, title, width, color=TEAL):
        super().__init__()
        self.number = number
        self.title = title
        self.width = width
        self.color = color
        self.height = 28

    def draw(self):
        c = self.canv
        # Main banner
        c.setFillColor(self.color)
        c.roundRect(0, 0, self.width, self.height, 4, fill=1, stroke=0)
        # Number box
        c.setFillColor(GOLD)
        c.roundRect(0, 0, 36, self.height, 4, fill=1, stroke=0)
        c.rect(28, 0, 12, self.height, fill=1, stroke=0)  # connect box

        # Number text
        c.setFillColor(colors.white)
        c.setFont("KorBold", 13)
        c.drawCentredString(18, 8, self.number)

        # Title text
        c.setFont("KorBold", 11)
        c.drawString(44, 8, self.title)


class CodeBlock(Flowable):
    """Code-style block with background and border."""
    def __init__(self, lines, width):
        super().__init__()
        self.lines = lines
        self.width = width
        self.padding = 8
        line_h = 13
        self.height = len(lines) * line_h + self.padding * 2

    def draw(self):
        c = self.canv
        h = self.height
        p = self.padding
        # Background
        c.setFillColor(CODE_BG)
        c.roundRect(0, 0, self.width, h, 3, fill=1, stroke=0)
        # Left accent border
        c.setFillColor(TEAL)
        c.rect(0, 0, 3, h, fill=1, stroke=0)
        # Text
        c.setFillColor(colors.HexColor("#2D3748"))
        c.setFont("Courier", 8.5)
        line_h = 13
        y = h - p - 10
        for line in self.lines:
            c.drawString(p + 6, y, line)
            y -= line_h


class LawBadge(Flowable):
    """Small gray badge for law references."""
    def __init__(self, text, width):
        super().__init__()
        self.text = text
        self.width = width
        self.height = 20

    def draw(self):
        c = self.canv
        c.setFillColor(LIGHT_GRAY)
        c.roundRect(0, 0, self.width, self.height, 3, fill=1, stroke=0)
        c.setStrokeColor(CODE_BORDER)
        c.roundRect(0, 0, self.width, self.height, 3, fill=0, stroke=1)
        c.setFillColor(LAW_COLOR)
        c.setFont("KorRegular", 8.5)
        c.drawString(8, 5, self.text)


# ─── Page Template (footer) ────────────────────────────────────────────────────
TODAY = datetime.now().strftime("%Y년 %m월 %d일")

def on_page(canvas, doc):
    canvas.saveState()
    page_num = doc.page
    canvas.setFont("KorRegular", 8)
    canvas.setFillColor(MED_GRAY)
    # Footer line
    canvas.setStrokeColor(CODE_BORDER)
    canvas.line(MARGIN_L, MARGIN_B - 5, PAGE_W - MARGIN_R, MARGIN_B - 5)
    # Left: document title
    canvas.drawString(MARGIN_L, MARGIN_B - 18,
                      "KYN — 구현 세법 & 메커니즘 정리")
    # Right: date + page
    right_text = f"{TODAY}  |  {page_num}쪽"
    canvas.drawRightString(PAGE_W - MARGIN_R, MARGIN_B - 18, right_text)
    canvas.restoreState()


# ─── Helper builders ──────────────────────────────────────────────────────────
def spacer(h_mm=4):
    return Spacer(1, h_mm * mm)

def hr(color=CODE_BORDER, thickness=0.5):
    return HRFlowable(width="100%", thickness=thickness, color=color, spaceAfter=4)

def make_table(data, col_widths, header_bg=NAVY, row_bg=LIGHT_TEAL):
    """Utility: build a styled table."""
    t = Table(data, colWidths=col_widths)
    style = [
        ("BACKGROUND",  (0, 0), (-1, 0),  header_bg),
        ("TEXTCOLOR",   (0, 0), (-1, 0),  colors.white),
        ("FONTNAME",    (0, 0), (-1, 0),  "KorBold"),
        ("FONTSIZE",    (0, 0), (-1, 0),  9),
        ("FONTNAME",    (0, 1), (-1, -1), "KorRegular"),
        ("FONTSIZE",    (0, 1), (-1, -1), 9),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_TEAL]),
        ("GRID",        (0, 0), (-1, -1), 0.5, CODE_BORDER),
        ("VALIGN",      (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING",  (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",(0, 0), (-1, -1), 8),
        ("ALIGN",       (1, 1), (-1, -1), "CENTER"),
        ("ALIGN",       (0, 0), (0, -1),  "LEFT"),
    ]
    t.setStyle(TableStyle(style))
    return t

def body_p(text, style_name="body", styles=None):
    return Paragraph(text, styles[style_name])


# ─── Content Sections ─────────────────────────────────────────────────────────
def build_story(styles):
    story = []
    W = CONTENT_W

    # ── Cover Header ─────────────────────────────────────────────────────
    story.append(NavyHeader(W, height=110))
    # Overlay text via Table (transparent cell over banner)
    title_cell = Paragraph("KYN — 구현 세법 &amp; 메커니즘 정리", styles["doc_title"])
    sub_cell   = Paragraph(
        "한국 세법 구현 메커니즘 · 2026년 현행 기준", styles["doc_subtitle"]
    )
    overlay = Table(
        [[title_cell], [sub_cell]],
        colWidths=[W],
    )
    overlay.setStyle(TableStyle([
        ("BACKGROUND",   (0, 0), (-1, -1), NAVY),
        ("TOPPADDING",   (0, 0), (-1, -1), 14),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 14),
        ("LEFTPADDING",  (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]))
    # Replace NavyHeader+overlay with a single combined table
    story.pop()  # remove NavyHeader
    story.append(overlay)
    story.append(spacer(6))

    # ── Table of Contents ─────────────────────────────────────────────────
    toc_items = [
        "1. 증여세 (Gift Tax)",
        "2. 상속세 (Inheritance Tax)",
        "3. 양도소득세 (Capital Gains Tax)",
        "4. 종합부동산세 (Comprehensive Real Estate Tax)",
        "5. 임대소득세 (Rental Income Tax)",
        "6. 법인세 (Corporate Tax)",
        "7. 소득세 (Income Tax)",
        "8. 가족간 차용증 (Family Loan)",
        "9. 법인전환 절세효과 (Corporate Conversion)",
        "10. 자산 성장 시뮬레이션",
        "11. LTV / DSCR (리스크 지표)",
        "12. PCI 역산 (세무조사 리스크)",
        "13. 현금흐름 분석",
        "14. 자금출처 소명 (Fund Source)",
    ]
    toc_data = [[Paragraph("목   차", styles["toc_title"])]]
    for item in toc_items:
        toc_data.append([Paragraph(item, styles["toc_item"])])
    toc_t = Table(toc_data, colWidths=[W])
    toc_t.setStyle(TableStyle([
        ("BACKGROUND",   (0, 0), (-1, 0),  LIGHT_TEAL),
        ("BACKGROUND",   (0, 1), (-1, -1), colors.white),
        ("LINEBELOW",    (0, 0), (-1, -1), 0.3, CODE_BORDER),
        ("TOPPADDING",   (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 5),
        ("LEFTPADDING",  (0, 0), (-1, -1), 12),
    ]))
    story.append(toc_t)
    story.append(spacer(8))
    story.append(PageBreak())

    # ════════════════════════════════════════════════════════════════════════
    # Section 1: 증여세
    # ════════════════════════════════════════════════════════════════════════
    story.append(SectionHeader("1", "증여세 (Gift Tax)", W))
    story.append(spacer(3))
    story.append(LawBadge("근거: 상속세 및 증여세법 §53, §56, §41의4", W))
    story.append(spacer(4))

    # Tax rate table
    gift_rate_data = [
        ["과세표준 구간", "세율", "누진공제"],
        ["1억 이하",     "10%", "—"],
        ["1억 ~ 5억",    "20%", "1,000만원"],
        ["5억 ~ 10억",   "30%", "6,000만원"],
        ["10억 ~ 30억",  "40%", "1.6억원"],
        ["30억 초과",    "50%", "4.6억원"],
    ]
    story.append(Paragraph("▶ 세율표", styles["label"]))
    story.append(make_table(gift_rate_data,
                            [W*0.42, W*0.28, W*0.30]))
    story.append(spacer(4))

    # Deduction table
    deduct_data = [
        ["관계",         "공제한도",   "비고"],
        ["배우자",       "6억원",      "혼인 중 배우자"],
        ["자녀·부모",    "5,000만원",  "직계존비속"],
        ["손자녀",       "2,000만원",  "세대생략 시 별도"],
        ["기타 친족",    "1,000만원",  "6촌 이내 혈족 등"],
        ["혼인·출산공제","1억원 추가", "2024~ 상증법 §53의2"],
    ]
    story.append(Paragraph("▶ 관계별 공제한도", styles["label"]))
    story.append(make_table(deduct_data,
                            [W*0.28, W*0.28, W*0.44]))
    story.append(spacer(4))

    story.append(Paragraph(
        "• <b>세대생략 할증:</b> 손자녀 직접 증여 시 산출세액 × 1.3배",
        styles["body"]
    ))
    story.append(Paragraph(
        "• <b>10년 합산:</b> 동일인으로부터의 증여액은 10년 내 합산하여 공제 적용",
        styles["body"]
    ))
    story.append(spacer(4))

    story.append(Paragraph("▶ 구현 위치", styles["label"]))
    story.append(CodeBlock([
        "lib/tax.ts",
        "  calcGiftTax(amount, relation, priorGifts, isGenerationSkip, marriageOrBirthBonus)",
        "",
        "로직: amount + priorGifts",
        "      → 관계별 공제 차감",
        "      → calcProgressiveTax()",
        "      → (손자녀면 x1.3)",
    ], W))
    story.append(spacer(8))

    # ════════════════════════════════════════════════════════════════════════
    # Section 2: 상속세
    # ════════════════════════════════════════════════════════════════════════
    story.append(SectionHeader("2", "상속세 (Inheritance Tax)", W))
    story.append(spacer(3))
    story.append(LawBadge("근거: 상속세 및 증여세법 §18, §19, §20, §21, §24", W))
    story.append(spacer(4))
    story.append(Paragraph(
        "세율: 증여세와 동일 10~50% 누진 (5구간)", styles["body"]
    ))

    inherit_deduct_data = [
        ["공제 항목",       "금액",              "비고"],
        ["기초공제",        "2억원",             "기본"],
        ["일괄공제",        "5억원",             "인적공제 합계와 비교, 큰 것 적용"],
        ["자녀공제",        "5,000만원 / 1인",   ""],
        ["배우자공제",      "5억 ~ 30억",        "실제 상속분 × 40%"],
        ["미성년공제",      "1,000만원 × 잔여연수","19세까지 잔여연수"],
        ["연로자공제",      "5,000만원 / 1인",   "65세 이상"],
        ["10년 사전증여",   "과표에 합산",       "10년 내 증여액"],
    ]
    story.append(Paragraph("▶ 공제 항목", styles["label"]))
    story.append(make_table(inherit_deduct_data,
                            [W*0.28, W*0.33, W*0.39]))
    story.append(spacer(4))

    story.append(Paragraph("▶ 구현 위치", styles["label"]))
    story.append(CodeBlock([
        "lib/tax.ts",
        "  calcInheritanceTax(totalEstate, members, priorGifts10yr)",
        "",
        "로직: 총자산 + 10년내증여",
        "      → 인적공제 계산",
        "      → max(인적공제합계, 일괄5억) + 배우자공제 차감",
        "      → calcProgressiveTax()",
    ], W))
    story.append(spacer(8))

    # ════════════════════════════════════════════════════════════════════════
    # Section 3: 양도소득세
    # ════════════════════════════════════════════════════════════════════════
    story.append(SectionHeader("3", "양도소득세 (Capital Gains Tax)", W))
    story.append(spacer(3))
    story.append(LawBadge("근거: 소득세법 §94, §95, §104", W))
    story.append(spacer(4))

    cgt_data = [
        ["보유기간",      "세율",       "비고"],
        ["1년 미만",      "50%",        "단기 단일세율"],
        ["1년 ~ 2년 미만","40%",        "단기 단일세율"],
        ["2년 이상",      "6% ~ 45%",   "소득세 기본세율 적용"],
    ]
    story.append(Paragraph("▶ 보유기간별 세율", styles["label"]))
    story.append(make_table(cgt_data, [W*0.36, W*0.28, W*0.36]))
    story.append(spacer(4))

    lthd_data = [
        ["보유기간", "장기보유특별공제율"],
        ["3년",      "6%"],
        ["5년",      "10%"],
        ["10년",     "20%"],
        ["15년",     "30%"],
    ]
    story.append(Paragraph("▶ 장기보유특별공제", styles["label"]))
    story.append(make_table(lthd_data, [W*0.4, W*0.6]))
    story.append(spacer(4))

    story.append(Paragraph(
        "• 기본공제: 250만원  |  금융자산: 소득세율 적용 (금투세 2025 폐지)",
        styles["body"]
    ))
    story.append(spacer(4))

    story.append(Paragraph("▶ 구현 위치", styles["label"]))
    story.append(CodeBlock([
        "lib/tax.ts",
        "  calcCapitalGainsTax(asset)",
        "",
        "로직: 시가 - 취득가 = 차익",
        "      → 장기보유공제 차감",
        "      → 250만 기본공제",
        "      → 보유기간별 세율 → calcIncomeTax()",
    ], W))
    story.append(spacer(8))

    # ════════════════════════════════════════════════════════════════════════
    # Section 4: 종합부동산세
    # ════════════════════════════════════════════════════════════════════════
    story.append(SectionHeader("4", "종합부동산세 (Comprehensive Real Estate Tax)", W))
    story.append(spacer(3))
    story.append(LawBadge("근거: 종합부동산세법 §8, §9 (2023년 완화 세율)", W))
    story.append(spacer(4))

    cret_data = [
        ["항목",             "내용"],
        ["기본공제",         "9억원 (1세대1주택 12억원)"],
        ["공정시장가액비율", "60%"],
        ["2주택 이하 세율",  "0.5% ~ 2.7% (7구간)"],
        ["3주택 이상 세율",  "0.5% ~ 5.0% (중과)"],
        ["법인 과세",        "공시가 × 60% × 2.7%"],
    ]
    story.append(make_table(cret_data, [W*0.38, W*0.62]))
    story.append(spacer(4))

    story.append(Paragraph("▶ 구현 위치", styles["label"]))
    story.append(CodeBlock([
        "lib/tax.ts",
        "  calcComprehensiveRealEstateTax(assets, isCorpOwned, isMultiHouse)",
        "",
        "로직: 자산별 (시가 × 공시가비율) 합산",
        "      → 9억 공제",
        "      → × 60% = 과세표준",
        "      → 세율 구간 적용",
    ], W))
    story.append(spacer(8))

    # ════════════════════════════════════════════════════════════════════════
    # Section 5: 임대소득세
    # ════════════════════════════════════════════════════════════════════════
    story.append(SectionHeader("5", "임대소득세 (Rental Income Tax)", W))
    story.append(spacer(3))
    story.append(LawBadge("근거: 소득세법 §14, §64의2", W))
    story.append(spacer(4))

    rental_data = [
        ["연 임대수익",       "과세 방식",              "세율"],
        ["2,000만원 이하",    "분리과세 vs 종합과세",    "14% 또는 6~45% 중 유리한 것 선택"],
        ["2,000만원 초과",    "타 소득과 합산 종합과세", "6% ~ 45%"],
    ]
    story.append(make_table(rental_data, [W*0.28, W*0.36, W*0.36]))
    story.append(spacer(4))

    story.append(Paragraph("▶ 구현 위치", styles["label"]))
    story.append(CodeBlock([
        "lib/tax.ts",
        "  calcRentalIncomeTax(annualRent, otherIncome)",
        "",
        "로직: 임대수익 <= 0.2억",
        "        → min(14%, 종합과세분)",
        "      초과",
        "        → calcIncomeTax(임대+기타) - calcIncomeTax(기타)",
    ], W))
    story.append(spacer(8))

    # ════════════════════════════════════════════════════════════════════════
    # Section 6: 법인세
    # ════════════════════════════════════════════════════════════════════════
    story.append(SectionHeader("6", "법인세 (Corporate Tax)", W))
    story.append(spacer(3))
    story.append(LawBadge("근거: 법인세법 §55 (2026년 귀속, 전구간 1%p 인상)", W))
    story.append(spacer(4))

    corp_data = [
        ["과세표준 구간",      "세율",  "비고"],
        ["2억 이하",           "10%",  ""],
        ["2억 ~ 200억",        "20%",  ""],
        ["200억 ~ 3,000억",    "22%",  ""],
        ["3,000억 초과",       "25%",  "지방소득세 10% 별도"],
    ]
    story.append(make_table(corp_data, [W*0.42, W*0.2, W*0.38]))
    story.append(spacer(4))

    story.append(Paragraph("▶ 구현 위치", styles["label"]))
    story.append(CodeBlock([
        "lib/tax.ts",
        "  calcCorporateTax(taxableIncome)",
    ], W))
    story.append(spacer(8))

    # ════════════════════════════════════════════════════════════════════════
    # Section 7: 소득세
    # ════════════════════════════════════════════════════════════════════════
    story.append(SectionHeader("7", "소득세 (Income Tax) — 양도세·임대세 기본세율", W))
    story.append(spacer(3))
    story.append(LawBadge("근거: 소득세법 §55", W))
    story.append(spacer(4))

    income_data = [
        ["과세표준 구간",   "세율", "누진공제"],
        ["1,400만 이하",   "6%",  "—"],
        ["5,000만 이하",   "15%", "126만원"],
        ["8,800만 이하",   "24%", "576만원"],
        ["1.5억 이하",     "35%", "1,544만원"],
        ["3억 이하",       "38%", "1,994만원"],
        ["5억 이하",       "40%", "2,594만원"],
        ["10억 이하",      "42%", "3,594만원"],
        ["10억 초과",      "45%", "6,594만원"],
    ]
    story.append(make_table(income_data, [W*0.40, W*0.20, W*0.40]))
    story.append(spacer(4))

    story.append(Paragraph("▶ 구현 위치", styles["label"]))
    story.append(CodeBlock([
        "lib/tax.ts",
        "  calcIncomeTax(income)",
    ], W))
    story.append(spacer(8))

    # ════════════════════════════════════════════════════════════════════════
    # Section 8: 가족간 차용증
    # ════════════════════════════════════════════════════════════════════════
    story.append(SectionHeader("8", "가족간 차용증 (Family Loan)", W))
    story.append(spacer(3))
    story.append(LawBadge("근거: 상증법 §41의4, 시행령 §31의4, 시행규칙 §10의5", W))
    story.append(spacer(4))

    loan_data = [
        ["항목",          "기준"],
        ["적정이자율",    "4.6% (당좌대출이자율)"],
        ["비과세 한도",   "이자차액 연 1,000만원 미만"],
        ["무이자 한도",   "1,000만 ÷ 4.6% ≈ 2.17억원"],
    ]
    story.append(make_table(loan_data, [W*0.3, W*0.7]))
    story.append(spacer(4))

    story.append(Paragraph("▶ 구현 위치", styles["label"]))
    story.append(CodeBlock([
        "lib/tax.ts",
        "  calcFamilyLoanAnalysis(principal, actualRatePct, relation, priorGifts)",
        "",
        "로직: 원금 × 4.6% = 적정이자",
        "      → 실제이자 차감 = 차액",
        "      → 차액 > 1,000만원이면 calcGiftTax() 적용",
    ], W))
    story.append(spacer(8))

    # ════════════════════════════════════════════════════════════════════════
    # Section 9: 법인전환 절세효과
    # ════════════════════════════════════════════════════════════════════════
    story.append(SectionHeader("9", "법인전환 절세효과 (Corporate Conversion)", W))
    story.append(spacer(3))
    story.append(LawBadge("근거: 조특법 §32 (현물출자 이월과세), §119 (취득세 50% 경감)", W))
    story.append(spacer(4))

    conv_data = [
        ["혜택",            "내용"],
        ["취득세 경감",     "부동산 시가 × 4% × 50% = 2% (~2027.12)"],
        ["양도세 이월",     "현물출자 시 양도세를 법인 매각 시점으로 이연"],
        ["급여 손금",       "대표이사 급여 법인 비용처리 → 법인 과세소득 축소"],
    ]
    story.append(make_table(conv_data, [W*0.28, W*0.72]))
    story.append(spacer(4))

    story.append(Paragraph("▶ 구현 위치", styles["label"]))
    story.append(CodeBlock([
        "lib/tax.ts",
        "  calcCorpConversionBenefit(rentalIncome, ceoSalary, otherIncome, assets)",
        "",
        "로직:",
        "  개인세:  calcIncomeTax(임대+기타)",
        "  법인세:  calcCorporateTax(임대-급여) + calcIncomeTax(급여+기타)",
        "  절세효과: 개인세 - 법인세",
        "  취득세:  부동산가액 × 2%",
    ], W))
    story.append(spacer(8))

    # ════════════════════════════════════════════════════════════════════════
    # Section 10: 자산 성장 시뮬레이션
    # ════════════════════════════════════════════════════════════════════════
    story.append(SectionHeader("10", "자산 성장 시뮬레이션", W))
    story.append(spacer(3))
    story.append(spacer(4))

    macro_data = [
        ["MacroSettings 변수",     "설명"],
        ["base_rate_pct",          "기준금리 (%)"],
        ["rate_shock_pct",         "금리 스트레스 시나리오 (%)"],
        ["apt_growth_pct",         "아파트 연 성장률 (%)"],
        ["land_growth_pct",        "토지 연 성장률 (%)"],
        ["commercial_growth_pct",  "상업용 부동산 연 성장률 (%)"],
        ["inflation_pct",          "물가상승률 (%)"],
    ]
    story.append(Paragraph("▶ 거시변수 (MacroSettings)", styles["label"]))
    story.append(make_table(macro_data, [W*0.42, W*0.58]))
    story.append(spacer(4))

    story.append(Paragraph("▶ 구현 위치", styles["label"]))
    story.append(CodeBlock([
        "lib/tax.ts",
        "  projectAssetValue(asset, years, macro)",
        "",
        "로직: 자산유형별 성장률(거시변수)",
        "      → 복리계산: 현재가 × (1 + 성장률)^연수",
    ], W))
    story.append(spacer(8))

    # ════════════════════════════════════════════════════════════════════════
    # Section 11: LTV / DSCR
    # ════════════════════════════════════════════════════════════════════════
    story.append(SectionHeader("11", "LTV / DSCR (리스크 지표)", W))
    story.append(spacer(3))
    story.append(spacer(4))

    risk_data = [
        ["지표",   "산식",                          "안전 기준"],
        ["LTV",    "총부채 ÷ 총자산가치 × 100",    "40% 이하"],
        ["DSCR",   "임대수익 ÷ 연이자",             "1.5x 이상"],
    ]
    story.append(make_table(risk_data, [W*0.18, W*0.50, W*0.32]))
    story.append(spacer(4))

    story.append(Paragraph("▶ 구현 위치", styles["label"]))
    story.append(CodeBlock([
        "lib/tax.ts",
        "  calcLTV(assets)",
        "  calcDSCR(assets)",
    ], W))
    story.append(spacer(8))

    # ════════════════════════════════════════════════════════════════════════
    # Section 12: PCI 역산
    # ════════════════════════════════════════════════════════════════════════
    story.append(SectionHeader("12", "PCI 역산 (세무조사 리스크)", W))
    story.append(spacer(3))
    story.append(spacer(4))

    story.append(Paragraph(
        "출처불명 = 재산증가액 + 소비지출 - 신고소득",
        styles["body_bold"]
    ))
    story.append(spacer(3))

    pci_data = [
        ["출처불명 금액",    "리스크 등급",  "판단"],
        ["1억 미만",         "안전",         "세무조사 가능성 낮음"],
        ["1억 ~ 5억",        "주의",         "소명 자료 준비 필요"],
        ["5억 이상",         "위험",         "세무조사 가능성 높음"],
    ]
    story.append(make_table(pci_data, [W*0.35, W*0.25, W*0.40]))
    story.append(spacer(4))

    story.append(Paragraph("▶ 구현 위치", styles["label"]))
    story.append(CodeBlock([
        "lib/tax.ts",
        "  calcPCI(assetIncrease, consumption, reportedIncome)",
    ], W))
    story.append(spacer(8))

    # ════════════════════════════════════════════════════════════════════════
    # Section 13: 현금흐름 분석
    # ════════════════════════════════════════════════════════════════════════
    story.append(SectionHeader("13", "현금흐름 분석", W))
    story.append(spacer(3))
    story.append(spacer(4))

    story.append(Paragraph(
        "순현금흐름 = 임대수익 - 보유세 - 대출이자 - 임대소득세",
        styles["body_bold"]
    ))
    story.append(spacer(4))

    story.append(Paragraph("▶ 구현 위치", styles["label"]))
    story.append(CodeBlock([
        "lib/tax.ts",
        "  calcAnnualCashflow(assets, macro, rateShock)",
    ], W))
    story.append(spacer(8))

    # ════════════════════════════════════════════════════════════════════════
    # Section 14: 자금출처 소명
    # ════════════════════════════════════════════════════════════════════════
    story.append(SectionHeader("14", "자금출처 소명 (Fund Source)", W))
    story.append(spacer(3))
    story.append(spacer(4))

    fs_data = [
        ["기준",             "내용"],
        ["소명 기준",        "취득가의 80% 이상 소명 필요"],
        ["소명 부족액 처리", "증여 추정 과세 적용"],
    ]
    story.append(make_table(fs_data, [W*0.3, W*0.7]))
    story.append(spacer(4))

    story.append(Paragraph("▶ 구현 위치", styles["label"]))
    story.append(CodeBlock([
        "lib/tax.ts",
        "  calcFundSourceSoMyung(acquisitionCost, soMyungPossible)",
    ], W))
    story.append(spacer(10))

    # ════════════════════════════════════════════════════════════════════════
    # Reference Laws & Disclaimer
    # ════════════════════════════════════════════════════════════════════════
    story.append(hr(NAVY, 1.5))
    story.append(spacer(4))

    ref_data = [
        ["주요 참고 법령", ""],
        ["상속세 및 증여세법 (상증법)",  "증여세, 상속세, 가족간 차용증"],
        ["소득세법",                     "양도소득세, 임대소득세, 소득세"],
        ["법인세법",                     "법인세"],
        ["종합부동산세법",               "종합부동산세"],
        ["조세특례제한법 (조특법)",      "법인전환 취득세 경감, 이월과세"],
    ]
    ref_t = Table(ref_data, colWidths=[W*0.48, W*0.52])
    ref_t.setStyle(TableStyle([
        ("BACKGROUND",   (0, 0), (-1, 0),  NAVY),
        ("TEXTCOLOR",    (0, 0), (-1, 0),  colors.white),
        ("FONTNAME",     (0, 0), (-1, 0),  "KorBold"),
        ("SPAN",         (0, 0), (-1, 0)),
        ("FONTNAME",     (0, 1), (-1, -1), "KorRegular"),
        ("FONTSIZE",     (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS",(0, 1), (-1, -1), [colors.white, LIGHT_TEAL]),
        ("GRID",         (0, 0), (-1, -1), 0.5, CODE_BORDER),
        ("TOPPADDING",   (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 5),
        ("LEFTPADDING",  (0, 0), (-1, -1), 10),
    ]))
    story.append(ref_t)
    story.append(spacer(6))

    note_data = [[
        Paragraph(
            "<b>세법 기준:</b> 2026년 현행 기준 — 상속세 개정안 2024.12 국회 부결로 세율 50% 유지",
            styles["body"]
        )
    ]]
    note_t = Table(note_data, colWidths=[W])
    note_t.setStyle(TableStyle([
        ("BACKGROUND",   (0, 0), (-1, -1), colors.HexColor("#FFF8E8")),
        ("LINEALL",      (0, 0), (-1, -1), 0.5, GOLD),
        ("LEFTPADDING",  (0, 0), (-1, -1), 10),
        ("TOPPADDING",   (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 8),
    ]))
    story.append(note_t)

    return story


# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    styles = make_styles()

    doc = SimpleDocTemplate(
        OUTPUT_PATH,
        pagesize=A4,
        leftMargin=MARGIN_L,
        rightMargin=MARGIN_R,
        topMargin=MARGIN_T,
        bottomMargin=MARGIN_B,
        title="KYN 세법 메커니즘 정리",
        author="KYN",
        subject="한국 세법 구현 메커니즘 2026",
    )

    story = build_story(styles)
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    print(f"PDF created: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
