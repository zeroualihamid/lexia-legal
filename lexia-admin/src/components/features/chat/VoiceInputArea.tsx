import React, { useRef, useState, useEffect, useCallback } from "react";
import {
  Send,
  Paperclip,
  Loader2,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Square,
  AudioLines,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

interface VoiceInputAreaProps {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isLoading: boolean;
  isUploading: boolean;
  textToSpeak?: string;
  onTextSelectedForTTS?: (text: string) => void;
}

const VoiceInputArea: React.FC<VoiceInputAreaProps> = ({
  input,
  onInputChange,
  onSend,
  onFileUpload,
  isLoading,
  isUploading,
  textToSpeak = "",
  onTextSelectedForTTS,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isTalkMode, setIsTalkMode] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const synthRef = useRef<SpeechSynthesis | null>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      onSend();
    }
  };

  const speak = useCallback(
    (text?: string) => {
      const toSpeak = text ?? textToSpeak;
      if (!toSpeak?.trim()) return;
      if (typeof window === "undefined" || !window.speechSynthesis) {
        setSpeechError("Text-to-speech non supporté");
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(toSpeak);
      utterance.lang = "fr-FR";
      utterance.rate = 0.95;
      utterance.onstart = () => setIsSpeaking(true);
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);
      window.speechSynthesis.speak(utterance);
      synthRef.current = window.speechSynthesis;
    },
    [textToSpeak]
  );

  const stopSpeaking = useCallback(() => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }
  }, []);

  const startListening = useCallback(() => {
    if (typeof window === "undefined") return;
    const SpeechRecognitionAPI =
      typeof SpeechRecognition !== "undefined"
        ? SpeechRecognition
        : typeof webkitSpeechRecognition !== "undefined"
          ? webkitSpeechRecognition
          : null;
    if (!SpeechRecognitionAPI) {
      setSpeechError("Reconnaissance vocale non supportée");
      return;
    }
    setSpeechError(null);
    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = isTalkMode;
    recognition.interimResults = true;
    recognition.lang = "fr-FR";
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = Array.from(event.results)
        .map((r) => r[0].transcript)
        .join("");
      if (transcript) onInputChange(input + (input ? " " : "") + transcript);
    };
    recognition.onerror = (e: any) => {
      if (e.error !== "aborted") setSpeechError(e.error || "Erreur reconnaissance");
      setIsListening(false);
    };
    recognition.onend = () => setIsListening(false);
    recognition.start();
    setIsListening(true);
    recognitionRef.current = recognition;
  }, [input, isTalkMode, onInputChange]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  useEffect(() => {
    return () => {
      stopListening();
      stopSpeaking();
    };
  }, [stopListening, stopSpeaking]);

  const handleTTS = () => {
    if (isSpeaking) {
      stopSpeaking();
    } else {
      const selected = window.getSelection()?.toString()?.trim();
      if (selected) {
        speak(selected);
        onTextSelectedForTTS?.(selected);
      } else {
        speak();
      }
    }
  };

  const hasContent = input.trim().length > 0;

  return (
    <div className="relative px-4 pb-4 pt-2">
      {/* Speech error banner */}
      <AnimatePresence>
        {speechError && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className="mb-2 text-xs text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 px-3 py-1.5 rounded-xl"
          >
            {speechError}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Listening indicator */}
      <AnimatePresence>
        {isListening && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="mb-3 flex items-center justify-center gap-3 py-3 rounded-2xl bg-red-500/5 border border-red-500/15"
          >
            <div className="relative flex items-center justify-center">
              <span className="absolute inline-flex h-8 w-8 rounded-full bg-red-500/20 animate-ping" />
              <span className="relative h-4 w-4 rounded-full bg-red-500" />
            </div>
            <span className="text-sm font-medium text-red-600 dark:text-red-400">
              Écoute en cours...
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 rounded-full text-xs text-red-600 hover:bg-red-500/10"
              onClick={stopListening}
            >
              <Square className="h-3 w-3 mr-1" />
              Arrêter
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* TTS indicator */}
      <AnimatePresence>
        {isSpeaking && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="mb-3 flex items-center justify-center gap-3 py-3 rounded-2xl bg-amber-500/5 border border-amber-500/15"
          >
            <AudioLines className="h-4 w-4 text-amber-600 dark:text-amber-400 animate-pulse" />
            <span className="text-sm font-medium text-amber-600 dark:text-amber-400">
              Lecture en cours...
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 rounded-full text-xs text-amber-600 hover:bg-amber-500/10"
              onClick={stopSpeaking}
            >
              <Square className="h-3 w-3 mr-1" />
              Arrêter
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main composer */}
      <div className="relative rounded-2xl border border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-white/[0.04] shadow-[0_1px_6px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_6px_rgba(0,0,0,0.2)] transition-shadow focus-within:shadow-[0_2px_12px_rgba(0,0,0,0.08)] dark:focus-within:shadow-[0_2px_12px_rgba(0,0,0,0.4)]">
        {/* Textarea */}
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isUploading
              ? "Téléchargement en cours..."
              : isListening
                ? "Dictez votre message..."
                : "Posez une question sur vos données..."
          }
          className="min-h-[52px] max-h-40 w-full overflow-y-auto bg-transparent border-0 shadow-none focus-visible:ring-0 text-[14px] leading-relaxed font-normal py-3.5 px-4 resize-none placeholder:text-muted-foreground/50"
          disabled={isUploading}
          rows={1}
        />

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-0.5">
            {/* Attach file */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
                  onClick={() => document.getElementById("file-upload-voice")?.click()}
                  disabled={isUploading}
                >
                  {isUploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Paperclip className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Joindre un fichier</TooltipContent>
            </Tooltip>
            <input
              type="file"
              id="file-upload-voice"
              className="hidden"
              multiple
              onChange={onFileUpload}
            />

            {/* Mic / STT */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-8 w-8 rounded-lg transition-all ${
                    isListening
                      ? "text-red-500 bg-red-500/10"
                      : "text-muted-foreground/60 hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
                  }`}
                  onClick={isListening ? stopListening : startListening}
                >
                  <Mic className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isListening ? "Arrêter l'écoute" : "Reconnaissance vocale"}
              </TooltipContent>
            </Tooltip>

            {/* Talk mode toggle */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-8 w-8 rounded-lg transition-all ${
                    isTalkMode
                      ? "text-blue-600 dark:text-blue-400 bg-blue-500/10"
                      : "text-muted-foreground/60 hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
                  }`}
                  onClick={() => setIsTalkMode((prev) => !prev)}
                >
                  {isTalkMode ? (
                    <Mic className="h-4 w-4" />
                  ) : (
                    <MicOff className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isTalkMode
                  ? "Mode conversation actif (clic pour désactiver)"
                  : "Activer le mode conversation continue"}
              </TooltipContent>
            </Tooltip>

            {/* Divider */}
            <div className="w-px h-4 bg-black/[0.06] dark:bg-white/[0.06] mx-1" />

            {/* TTS */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-8 w-8 rounded-lg transition-all ${
                    isSpeaking
                      ? "text-amber-500 bg-amber-500/10"
                      : "text-muted-foreground/60 hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
                  }`}
                  onClick={handleTTS}
                  disabled={
                    !isSpeaking &&
                    !textToSpeak?.trim() &&
                    !window.getSelection()?.toString()?.trim()
                  }
                >
                  {isSpeaking ? (
                    <VolumeX className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isSpeaking
                  ? "Arrêter la lecture"
                  : "Lire la dernière réponse à voix haute"}
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Send */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                className={`h-8 w-8 rounded-xl transition-all ${
                  hasContent && !isLoading
                    ? "bg-foreground text-background hover:opacity-80 shadow-sm"
                    : "bg-black/[0.05] dark:bg-white/[0.05] text-muted-foreground/40 cursor-not-allowed"
                }`}
                onClick={onSend}
                disabled={!hasContent || isLoading || isUploading}
              >
                {isLoading ? (
                  <Square className="h-3.5 w-3.5" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isLoading ? "Arrêter" : "Envoyer"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Hint text */}
      <p className="text-center text-[11px] text-muted-foreground/40 mt-2">
        qclick peut faire des erreurs. Vérifiez les informations importantes.
      </p>
    </div>
  );
};

export default VoiceInputArea;
