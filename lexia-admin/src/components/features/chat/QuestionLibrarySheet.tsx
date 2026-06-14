import React, { useState } from 'react';
import { Library, ChevronRight, Search } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { BANKING_QUESTIONS } from '@/constants/questions';

interface QuestionLibrarySheetProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelectQuestion: (question: string) => void;
}

const QuestionLibrarySheet: React.FC<QuestionLibrarySheetProps> = ({ open, onOpenChange, onSelectQuestion }) => {
    const [searchQuery, setSearchQuery] = useState('');

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="settings-ui flex w-80 flex-col border-l border-[#E8E6E1] bg-[#FBFAF7] p-0 text-[#2B2B2B]">
                <SheetHeader className="border-b border-[#E8E6E1] bg-white p-4">
                    <SheetTitle className="settings-display flex items-center gap-2 text-sm text-[#2B2B2B]">
                        <Library className="h-4 w-4" />
                        Bibliothèque de questions
                    </SheetTitle>
                    <SheetDescription className="sr-only">
                        Sélectionnez une question prédéfinie
                    </SheetDescription>
                </SheetHeader>

                <div className="border-b border-[#E8E6E1] bg-[#FBFAF7] p-3">
                    <div className="relative">
                        <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[#A09E99]" />
                        <Input
                            placeholder="Filtrer les questions..."
                            className="h-9 border-[#E8E6E1] bg-white py-2 pl-8 pr-3 text-xs focus-visible:ring-[#0D7377]/15"
                            value={searchQuery}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                        />
                    </div>
                </div>

                <ScrollArea className="flex-1 p-2">
                    <div className="space-y-4">
                        {BANKING_QUESTIONS.map((category: any) => {
                            const filteredQuestions = category.questions.filter((q: string) =>
                                q.toLowerCase().includes(searchQuery.toLowerCase()) ||
                                category.title.toLowerCase().includes(searchQuery.toLowerCase())
                            );
                            if (filteredQuestions.length === 0) return null;

                            return (
                                <div key={category.id} className="space-y-1">
                                    <h4 className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#A09E99]">
                                        {category.title}
                                    </h4>
                                    {filteredQuestions.map((q: string, i: number) => (
                                        <button
                                            key={i}
                                            onClick={() => {
                                                onSelectQuestion(q);
                                                onOpenChange(false);
                                            }}
                                            className="group flex w-full items-start gap-2 rounded-xl border border-transparent p-2 text-left text-xs transition-all hover:border-[#0D7377]/15 hover:bg-[#F1FAFA] hover:text-[#0D7377]"
                                        >
                                            <ChevronRight className="h-3 w-3 mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                                            <span className="leading-relaxed">{q}</span>
                                        </button>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                </ScrollArea>
            </SheetContent>
        </Sheet>
    );
};

export default QuestionLibrarySheet;
